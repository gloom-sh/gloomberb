import { mkdir } from "fs/promises";
import { join, resolve } from "path";
import { Jimp } from "jimp";
import { testAppEnv } from "../test-app-env";
import { takeOption } from "../tui-benchmark-harness";
import { FADE_PX } from "../../src/renderers/dom/host/overflow-fade-px";
import { cacheDir } from "./browser";
import { serveFixturePage } from "./page";

/**
 * The active title-bar tab opens into its pane in the system WebKit, the
 * engine the macOS app draws with (Safari's too). WebKit draws a strip wider
 * than its pane as a scrolling layer of its own, placed on a whole device
 * pixel, so in a title bar a fraction of a pixel off the grid (a split or a
 * moved window leaves one there) a tab that only reached the bar's rule ended
 * a device pixel above it, and the rule's last row showed under it. Chrome
 * draws such a strip flush, so the Chrome checks cannot see this.
 *
 *   bun run check:title-tabs-webkit [--root <checkout>] [--out <dir>]
 *
 * macOS only. Draws the `research` fixture scenario (strips that scroll:
 * Ticker Research's docked and floating, and a stack's tabs) at device scale
 * 2 in an off-screen WKWebView, through the layers WebKit hands the window
 * (wkwebview-layers.swift), with the title bars at ten fractions of a pixel
 * and two text sizes. Fails when a device row of a title bar's rule under the
 * active tab is the rule's colour. `--root` checks another checkout's sources
 * with this checkout's fixture; pictures go to `--out` (the cache folder).
 */

interface Box { left: number; right: number; top: number; bottom: number }
interface Strip { pane: string; role: string; header: Box; tab: Box; list: Box; hidden: { start: boolean; end: boolean } }

const VIEWPORT = { width: 1200, height: 760 };
const SCALE = 2;
/** The window focused while drawn, as the reported one was. */
const FOCUSED = "research:float";
const STRIPS = [["research:dock", "pane-header-tabs"], ["research:float", "pane-header-tabs"], ["plain:s6", "pane-stack-tabs"]] as const;

/** Gives the strips once the floating window has focus and the page has drawn them. */
const PROBE = `(() => {
  const body = document.querySelector('[data-gloom-pane-id="${FOCUSED}"] > [data-gloom-role=pane-body]');
  if (!body) return null;
  if (!window.__titleTabFocus) {
    window.__titleTabFocus = true;
    body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    return null;
  }
  const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
  const strips = ${JSON.stringify(STRIPS)}.map(([pane, role]) => {
    const header = document.querySelector('[data-gloom-pane-id="' + pane + '"] [data-gloom-role=pane-header]');
    const list = header?.querySelector('[data-gloom-role=' + role + '] [data-gloom-role=tab-list]');
    const tab = list?.querySelector('[role=tab][aria-selected=true]');
    if (!tab) return null;
    return { pane, role, header: box(header), tab: box(tab), list: box(list), hidden: { start: list.scrollLeft > 1, end: list.scrollLeft + list.clientWidth < list.scrollWidth - 1 } };
  });
  return strips.every(Boolean) ? JSON.stringify(strips) : null;
})()`;

const args = process.argv.slice(2);
const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
const out = resolve(takeOption(args, "--out") ?? cacheDir("title-tab-webkit"));

/** The pictures' pixels, read as the screen shows them. */
class Picture {
  constructor(private readonly width: number, private readonly data: Buffer | Uint8Array) {}
  at(x: number, y: number): number[] {
    const index = (Math.floor(y) * this.width + Math.floor(x)) * 4;
    return [this.data[index]!, this.data[index + 1]!, this.data[index + 2]!];
  }
}

const near = (a: number[], b: number[]) => a.every((value, index) => Math.abs(value - b[index]!) <= 8);

/** Every device row of the title bar's rule under the active tab, against the same row beside it: the rule's colour there is a failure. */
function checkStrip(picture: Picture, strip: Strip): string | null {
  const { header, tab, list, hidden } = strip;
  // The part of the tab no fade covers, where its fill is whole.
  const left = Math.max(tab.left, list.left + (hidden.start ? FADE_PX : 0));
  const right = Math.min(tab.right, list.right - (hidden.end ? FADE_PX : 0));
  const x = (right - left > 8 ? (left + right) / 2 : (tab.left + tab.right) / 2) * SCALE;
  const beside = (header.left + 3) * SCALE;
  const rule = picture.at(beside, (header.bottom - 0.5) * SCALE);
  const bar = picture.at(beside, (header.bottom - 2.5) * SCALE);
  const body = picture.at(x, (header.bottom + 1.5) * SCALE);
  if (near(rule, bar) || near(rule, body)) return `${strip.pane} (${strip.role}): no rule to check under the tab`;
  const shown: number[] = [];
  for (let y = Math.floor((header.bottom - 2) * SCALE); y < Math.ceil((header.bottom + 1) * SCALE); y += 1) {
    if (near(picture.at(beside, y), rule) && near(picture.at(x, y), rule)) shown.push(y);
  }
  return shown.length === 0 ? null
    : `${strip.pane} (${strip.role}): the title bar's rule shows under the active tab at device rows ${shown.join(", ")} (title bar's bottom at ${(header.bottom * SCALE).toFixed(2)})`;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("This draws in the macOS system WebKit: run it on a Mac.");
  await mkdir(out, { recursive: true });
  const helper = join(cacheDir("title-tab-webkit-helper"), "wkwebview-layers");
  await mkdir(join(helper, ".."), { recursive: true });
  const build = Bun.spawnSync(["swiftc", "-O", join(import.meta.dir, "wkwebview-layers.swift"), "-o", helper], { stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) throw new Error("wkwebview-layers.swift did not build");

  const page = await serveFixturePage(root, cacheDir("build", `title-tab-webkit-${process.pid}`));
  const failures: string[] = [];
  let cases = 0;
  try {
    for (const font of [12, 13]) {
      for (let step = 0; step < 10; step += 1) {
        // The floating windows a tenth of a cell apart, the dock's split a hundredth of its height.
        const query = `scenario=research&font=${font}&at=70,${(12 + step / 10).toFixed(1)}&ratio=${(0.33 + step / 100).toFixed(2)}`;
        const name = `research-${font}px-${step}`;
        // Not spawnSync: this process serves the page the view loads.
        const run = Bun.spawn([helper, new URL(`?${query}`, page.url).href, `${VIEWPORT.width}x${VIEWPORT.height}`, String(SCALE), join(out, name), PROBE], { env: testAppEnv(), stdout: "ignore", stderr: "pipe", timeout: 60_000 });
        if (await run.exited !== 0) throw new Error(`wkwebview-layers.swift failed on ${query}: ${(await new Response(run.stderr).text()).trim()}`);
        const strips = await Bun.file(join(out, `${name}.json`)).json() as Strip[];
        const image = await Jimp.read(join(out, `${name}.png`));
        const picture = new Picture(image.bitmap.width, image.bitmap.data);
        const problems = strips.map((strip) => checkStrip(picture, strip)).filter((problem): problem is string => problem !== null);
        cases += 1;
        if (problems.length === 0) console.log(`ok   ${query}`);
        else {
          console.log(`FAIL ${query}\n     ${problems.join("\n     ")}\n     picture: ${join(out, `${name}.png`)}`);
          failures.push(query);
        }
      }
    }
  } finally {
    await page.close();
  }
  console.log(`\n${cases - failures.length}/${cases} passed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
