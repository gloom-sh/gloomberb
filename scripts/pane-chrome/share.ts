import { mkdir } from "fs/promises";
import { join } from "path";
import { cacheDir, click, drag, evaluate, launchBrowser, sleep, waitFor, type Cdp } from "./browser";
import { shareFixtureConfig, startShareServer } from "./share-server";

async function key(cdp: Cdp, key: string, code: string, modifiers = 0, repeat = false) {
  const windowsVirtualKeyCode = key === "Escape" ? 27 : key === "Enter" ? 13 : key === "ArrowDown" ? 40 : key.toUpperCase().charCodeAt(0);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, modifiers, autoRepeat: repeat });
  if (!repeat) await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, modifiers });
}

async function point(cdp: Cdp, expression: string) {
  const result = await evaluate<{ x: number; y: number } | null>(cdp, `(() => {
    const e = ${expression}; if (!e) return null;
    e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!result) throw new Error(`No pointer target: ${expression}`);
  return result;
}
const byText = (selector: string, text: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const dialog = `document.querySelector('[role="dialog"]')`;

/** Real web app, real keys and pointers, a loopback-only stand-in API. Never posts to a public channel. */
export async function checkGlobalShare(root: string): Promise<void> {
  const build = Bun.spawn([process.execPath, "run", "web:build"], { cwd: root, stdout: "ignore", stderr: "pipe" });
  const errors = new Response(build.stderr).text();
  if (await build.exited !== 0) throw new Error(await errors);
  await errors;
  const api = startShareServer(root);
  const browser = await launchBrowser("global-share", 1440, 900);
  const { cdp } = browser;
  const shots = cacheDir("share-evidence");
  await mkdir(shots, { recursive: true });
  const screenshot = async (name: string) => {
    const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(shots, `${name}.png`), Buffer.from(shot.data, "base64"));
  };
  const opened = async () => {
    if (!await waitFor(cdp, `!!${dialog}`, 15_000)) throw new Error("Share dialog did not open");
    if (await evaluate<number>(cdp, `document.querySelectorAll('[role="dialog"]').length`) !== 1) throw new Error("More than one Share dialog");
    if (!await waitFor(cdp, `!!document.querySelector('input[placeholder="Optional"]')`)) throw new Error("Share form did not render");
  };
  try {
    // No external HTTP or websocket access, including telemetry and bundled-plugin feeds.
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: ["https://*", "wss://*"] });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      localStorage.setItem('gloomberb.web.config.v1', ${JSON.stringify(JSON.stringify(shareFixtureConfig("/share-fixture")))});
      Object.defineProperty(navigator, 'doNotTrack', { value: '1' });
      window.__shareDialogCount = 0;
      new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1 && (node.matches?.('[role="dialog"]') || node.querySelector?.('[role="dialog"]'))) window.__shareDialogCount++;
      }}).observe(document, { childList: true, subtree: true });
    ` });
    await cdp.send("Browser.grantPermissions", { origin: api.url, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    await cdp.send("Page.navigate", { url: api.url });
    if (!await waitFor(cdp, `!!document.querySelector('[data-gloom-pane-id="chart:share"] [data-gloom-role="pane-action"]')`, 20_000)) {
      throw new Error(await evaluate(cdp, "document.body.innerText"));
    }
    await sleep(500);
    const menuButton = `document.querySelector('[data-gloom-pane-id="chart:share"] [data-gloom-role="pane-action"]')`;
    await click(cdp, await point(cdp, menuButton));
    if (!await waitFor(cdp, `!!document.querySelector('[role="menu"]')`)) throw new Error("Pane menu missing");
    const entries = await evaluate<string[]>(cdp, `[...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent.trim())`);
    if (entries.filter(text => /share/i.test(text)).length !== 1) throw new Error(`Duplicate/missing Share entry: ${entries.join(", ")}`);
    const footer = await evaluate<string>(cdp, `document.querySelector('[data-gloom-role="pane-footer"]')?.textContent ?? ''`);
    if (/share/i.test(footer)) throw new Error(`Chart footer still offers Share: ${footer}`);
    const shareItem = await point(cdp, `[...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim().startsWith("Share"))`);
    await screenshot("menu");
    await click(cdp, shareItem);
    await opened();
    await screenshot("dialog");
    await key(cdp, "Escape", "Escape");
    await sleep(800);

    // A genuine held-key event opens once, including repeats after dismissing it.
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "S", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 10 });
    await opened();
    const count = await evaluate<number>(cdp, "window.__shareDialogCount");
    for (let i = 0; i < 8; i++) await key(cdp, "S", "KeyS", 10, true);
    await key(cdp, "Escape", "Escape");
    for (let i = 0; i < 8; i++) await key(cdp, "S", "KeyS", 10, true);
    await sleep(500);
    if (await evaluate(cdp, `!!${dialog} || window.__shareDialogCount !== ${count}`)) throw new Error("Held Share key opened another dialog");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "S", code: "KeyS", modifiers: 10 });
    // Keep a hold refused even when the platform does not mark its repeats.
    for (let i = 0; i < 45; i++) {
      await key(cdp, "S", "KeyS", 10);
      await sleep(33);
    }
    if (await evaluate(cdp, `!!${dialog} || window.__shareDialogCount !== ${count}`)) throw new Error("Unflagged hold reopened Share");
    await sleep(800);

    // Both old phrases find ONE command, and keyboard activation opens the same dialog.
    for (const phrase of ["share pane", "share to chat"]) {
      await key(cdp, "p", "KeyP", 2);
      await cdp.send("Input.insertText", { text: phrase });
      if (!await waitFor(cdp, `!!document.querySelector('[data-command-bar-row-selected="true"]')`)) throw new Error("Command bar did not find Share");
      if (!await waitFor(cdp, `[...document.querySelectorAll('*')].filter(e => !e.children.length && e.textContent.trim() === 'Share').length === 1`)) throw new Error("Expected exactly one Share command");
      for (let i = 0; i < 8; i++) {
        if ((await evaluate<string>(cdp, `document.querySelector('[data-command-bar-row-selected="true"]')?.textContent ?? ''`)).trim() === "Share") break;
        await key(cdp, "ArrowDown", "ArrowDown");
        await sleep(60);
      }
      const selected = await evaluate<string>(cdp, `document.querySelector('[data-command-bar-row-selected="true"]').textContent`);
      if (selected.trim() !== "Share") throw new Error(`Wrong command: ${selected}`);
      await key(cdp, "Enter", "Enter");
      await opened();
      await key(cdp, "Escape", "Escape");
      await sleep(800);
    }

    // Share while the chart's pan is still waiting for its debounced settings write.
    const plot = await point(cdp, `document.querySelector('[data-gloom-role="composite-chart-panel"]')`);
    await drag(cdp, plot, [{ x: plot.x - 65, y: plot.y }], 3);
    // Copy link uses the existing public payload and clipboard, with no chat upload.
    await key(cdp, "S", "KeyS", 10);
    await opened();
    await click(cdp, await point(cdp, byText("button", "Post to chat")));
    await click(cdp, await point(cdp, byText('[role="option"]', "Copy link")));
    await click(cdp, await point(cdp, `[...document.querySelectorAll('button')].find(e => e.textContent.trim().startsWith('Copy link') && !e.hasAttribute('aria-haspopup'))`));
    if (!await waitFor(cdp, `!${dialog}`)) throw new Error("Copy link did not finish");
    if (api.shares.length !== 1 || api.uploads.length !== 0) throw new Error("Copy link changed chat or created duplicate links");
    const payload = api.shares[0] as { data: { layout: { layout: { instances: Array<{ settings?: Record<string, unknown> }> } } } };
    if (!payload.data.layout.layout.instances[0]?.settings?.chartInteractionViewport) throw new Error("Global Share lost the chart's pending pan");
    const copied = await evaluate<string>(cdp, "navigator.clipboard.readText()");
    if (!copied.startsWith("https://term.gloom.sh/api/shares/")) throw new Error(`Wrong clipboard link: ${copied}`);

    await sleep(800);
    // Draw, then share before the drawing store's debounce expires.
    await key(cdp, "D", "KeyD", 8);
    await drag(cdp, { x: plot.x - 100, y: plot.y + 20 }, [{ x: plot.x + 70, y: plot.y - 30 }], 3);
    // Post carries the same view by default. Opt-out is remembered on reopening.
    await key(cdp, "S", "KeyS", 10);
    await opened();
    await cdp.send("Input.insertText", { text: "Example view" });
    await click(cdp, await point(cdp, `[...document.querySelectorAll('button')].find(e => e.textContent.trim().startsWith('Post') && !e.hasAttribute('aria-haspopup'))`));
    if (!await waitFor(cdp, `!${dialog}`, 15_000)) throw new Error("Post did not finish");
    if (api.messages.length !== 1 || !String(api.messages[0]?.content).startsWith("Example view\n\nhttps://term.gloom.sh/api/shares/")) throw new Error("Post omitted its view link");
    const drawnPayload = api.shares[1] as typeof payload;
    const drawings = drawnPayload?.data.layout.layout.instances[0]?.settings?.chartDrawings;
    if (!Array.isArray(drawings) || drawings.length !== 1) throw new Error("Global Share lost the chart's new drawing");
    await sleep(800);
    await key(cdp, "S", "KeyS", 10);
    await opened();
    await click(cdp, await point(cdp, `document.querySelector('input[type="checkbox"]')`));
    await key(cdp, "Escape", "Escape");
    await sleep(800);
    await key(cdp, "S", "KeyS", 10);
    await opened();
    if (await evaluate(cdp, `document.querySelector('input[type="checkbox"]').checked`)) throw new Error("Include link preference was not remembered");
    await key(cdp, "Escape", "Escape");
    await Bun.write(join(shots, "requests.json"), JSON.stringify({ shares: api.shares, messages: api.messages, requests: api.requests }, null, 2));
    console.log(`ok   global Share: real pointer menu, aliases, keys/repeat, copy, post, remembered link (${shots})`);
  } catch (error) {
    await screenshot("failure");
    console.error(await evaluate(cdp, "document.body.innerText"));
    throw error;
  } finally {
    await browser.close();
    api.server.stop(true);
  }
}
