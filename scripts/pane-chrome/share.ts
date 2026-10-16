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
  // Each Share makes one link, copies it and says so, with no dialog on the way.
  const copied = async (count: number, what: string) => {
    if (!await waitFor(cdp, `window.__linkCopiedToasts >= ${count}`, 15_000)) throw new Error(`${what}: no "Link copied" toast`);
    if (api.shares.length !== count) throw new Error(`${what}: ${api.shares.length} links for ${count} shares`);
    const link = await evaluate<string>(cdp, "navigator.clipboard.readText()");
    const id = count.toString(16).padStart(32, "a");
    if (link !== `https://term.gloom.sh/api/shares/${id}/open`) throw new Error(`${what}: wrong clipboard link ${link}`);
    if (await evaluate<number>(cdp, "window.__shareDialogCount") !== 0) throw new Error(`${what}: Share opened a dialog`);
  };
  const lastSettings = () => (api.shares.at(-1) as {
    data: { layout: { layout: { instances: Array<{ settings?: Record<string, unknown> }> } } };
  }).data.layout.layout.instances[0]?.settings ?? {};
  try {
    // No external HTTP or websocket access, including telemetry and bundled-plugin feeds.
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: ["https://*", "wss://*"] });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      localStorage.setItem('gloomberb.web.config.v1', ${JSON.stringify(JSON.stringify(shareFixtureConfig("/share-fixture")))});
      Object.defineProperty(navigator, 'doNotTrack', { value: '1' });
      window.__shareDialogCount = 0;
      window.__linkCopiedToasts = 0;
      new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        // A dialog other than a menu's popover.
        const modal = '[role="dialog"]:not(.gloom-popover)';
        if (node.matches?.(modal) || node.querySelector?.(modal)) window.__shareDialogCount++;
        const toast = node.matches?.('.gloom-toast') ? node : node.querySelector?.('.gloom-toast');
        if (toast?.textContent.includes('Link copied')) window.__linkCopiedToasts++;
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
    await copied(1, "Share from the pane menu");
    await screenshot("copied");
    await sleep(800);

    // A genuine held-key event shares once, repeats and all.
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "S", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 10 });
    await copied(2, "Cmd/Ctrl+Shift+S");
    for (let i = 0; i < 8; i++) await key(cdp, "S", "KeyS", 10, true);
    await sleep(500);
    if (api.shares.length !== 2) throw new Error("Held Share key made another link");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "S", code: "KeyS", modifiers: 10 });
    // Keep a hold refused even when the platform does not mark its repeats.
    for (let i = 0; i < 45; i++) {
      await key(cdp, "S", "KeyS", 10);
      await sleep(33);
    }
    await sleep(500);
    if (api.shares.length !== 2) throw new Error("Unflagged hold shared again");
    await sleep(800);

    // Each phrase finds ONE command, and keyboard activation shares the same way.
    let count = 2;
    for (const phrase of ["share pane", "copy link"]) {
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
      await copied(++count, `Command bar "${phrase}"`);
      await sleep(800);
    }

    // Share while the chart's pan is still waiting for its debounced settings write.
    const plot = await point(cdp, `document.querySelector('[data-gloom-role="composite-chart-panel"]')`);
    await drag(cdp, plot, [{ x: plot.x - 65, y: plot.y }], 3);
    await key(cdp, "S", "KeyS", 10);
    await copied(++count, "Share after a pan");
    if (!lastSettings().chartInteractionViewport) throw new Error("Share lost the chart's pending pan");
    await sleep(800);

    // Draw, then share before the drawing store's debounce expires.
    await key(cdp, "D", "KeyD", 8);
    await drag(cdp, { x: plot.x - 100, y: plot.y + 20 }, [{ x: plot.x + 70, y: plot.y - 30 }], 3);
    await key(cdp, "S", "KeyS", 10);
    await copied(++count, "Share after a drawing");
    const drawings = lastSettings().chartDrawings;
    if (!Array.isArray(drawings) || drawings.length !== 1) throw new Error("Share lost the chart's new drawing");
    if (api.messages.length !== 0 || api.uploads.length !== 0) throw new Error("Share posted to chat");
    await Bun.write(join(shots, "requests.json"), JSON.stringify({ shares: api.shares, messages: api.messages, requests: api.requests }, null, 2));
    console.log(`ok   global Share: real pointer menu, aliases, keys/repeat, link copied with no dialog, pending pan and drawing (${shots})`);
  } catch (error) {
    await screenshot("failure");
    console.error(await evaluate(cdp, "document.body.innerText"));
    throw error;
  } finally {
    await browser.close();
    api.server.stop(true);
  }
}
