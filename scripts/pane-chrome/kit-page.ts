import { mkdir } from "fs/promises";
import { join, resolve } from "path";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir, evaluate, launchBrowser, sleep, type Cdp } from "./browser";
import { serveFixturePage } from "./page";

/**
 * The kit page: every family of the design system in every state, drawn by
 * the shared components (kit-fixture.tsx), the benchmark a UI change is held
 * to (docs/pane-conventions.md, "Design system").
 *
 *   bun run kit:page                       serve it; open the printed URL
 *   bun run kit:page --shots <dir>         one picture per family, theme and width
 *       [--themes white,paper] [--widths 640,1280] [--root <checkout>]
 *
 * The URL takes `&family=<id>` for one family and `&theme=<id>` for a theme.
 * Pictures force the hover and keyboard focus the page marks
 * (`data-kit-force`), which a still page cannot show otherwise.
 */

const FAMILIES = ["type", "tokens", "buttons", "tabs", "chips", "fields", "tables", "states", "content", "chrome", "surfaces", "reader"];

const args = process.argv.slice(2);
const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
const shotsDir = takeOption(args, "--shots");
const themes = (takeOption(args, "--themes") ?? "white,paper").split(",");
const widths = (takeOption(args, "--widths") ?? "640,1280").split(",").map(Number);

/** Tags what each marked specimen should show as hovered or focused, then forces that state. */
async function forceStates(cdp: Cdp): Promise<void> {
  await evaluate(cdp, `(() => {
    const interactive = "button, [role=button], [role=tab], [role=radio], [role=link], [data-gloom-link], input, [data-gloom-ui=card], .gloom-icon-button";
    for (const sample of document.querySelectorAll("[data-kit-force]")) {
      const state = sample.getAttribute("data-kit-force");
      const label = sample.querySelector("[data-kit-hover-target]")?.getAttribute("data-kit-hover-target");
      const target = label
        ? [...sample.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.trim() === label)
        : sample.querySelector(interactive);
      target?.setAttribute("data-kit-target", state);
    }
    for (const table of document.querySelectorAll("[data-kit-hover-row]")) {
      const rows = table.querySelectorAll("[data-gloom-role=data-table-row]");
      rows[Number(table.getAttribute("data-kit-hover-row"))]?.setAttribute("data-kit-target", "hover");
    }
  })()`);
  const { root: document } = await cdp.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: -1 });
  for (const [state, pseudo] of [["hover", ["hover"]], ["focus", ["focus", "focus-visible"]]] as const) {
    const { nodeIds } = await cdp.send<{ nodeIds: number[] }>("DOM.querySelectorAll", { nodeId: document.nodeId, selector: `[data-kit-target="${state}"]` });
    for (const nodeId of nodeIds) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [...pseudo] });
  }
}

async function main(): Promise<void> {
  const page = await serveFixturePage(root, cacheDir("kit-page"));
  if (!shotsDir) {
    console.log(`Kit page: ${page.url.href}?scenario=kit (add &family=<${FAMILIES.join("|")}> and &theme=paper)`);
    await new Promise(() => {});
    return;
  }
  const out = resolve(shotsDir);
  await mkdir(out, { recursive: true });
  const browser = await launchBrowser("kit-page", widths[0]!, 900);
  const { cdp } = browser;
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    for (const theme of themes) {
      for (const width of widths) {
        for (const family of FAMILIES) {
          await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
          const loaded = cdp.once("Page.loadEventFired", 60_000);
          await cdp.send("Page.navigate", { url: `${page.url.href}?scenario=kit&family=${family}&theme=${theme}` });
          await loaded;
          for (let tries = 0; tries < 100 && !await evaluate<boolean>(cdp, "window.__paneChrome?.ready === true"); tries += 1) await sleep(50);
          await sleep(400);
          // The whole family in one picture: the window grows to the page.
          const height = await evaluate<number>(cdp, `Math.ceil(document.querySelector("[data-kit-page] > *")?.getBoundingClientRect().height ?? 900) + 48`);
          await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: Math.max(300, height), deviceScaleFactor: 1, mobile: false });
          await sleep(300);
          await forceStates(cdp);
          await sleep(150);
          const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
          await Bun.write(join(out, `${theme}-${width}-${family}.png`), Buffer.from(data, "base64"));
        }
        console.log(`${theme} ${width}px: ${FAMILIES.length} families`);
      }
    }
    if (page.strayRequests.length > 0) console.warn(`The kit page asked for: ${page.strayRequests.join(", ")}`);
  } finally {
    await browser.close();
    await page.close();
  }
  console.log(out);
}

await main();
