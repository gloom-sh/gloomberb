import { appendFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir, evaluate, launchBrowser, waitFor, type Cdp } from "./browser";
import { serveFixturePage } from "./page";
import {
  PANE_SCREENSHOT_MAX_BYTES,
  PANE_SCREENSHOT_MAX_EDGE,
  PANE_SCREENSHOT_MIN_WIDTH,
  paneScreenshotScale,
} from "../../src/remote/pane-screenshot";

/**
 * Copy Screenshot paints a pane into a canvas itself (src/utils/dom-screenshot.ts),
 * so anything it does not know how to paint is missing from the image while
 * the screen shows it: the speedometer gauge and SVG charts were.
 * This renders chart panes on invented data in headless Chrome (fixture.tsx,
 * `screenshot`), takes the pane's Copy Screenshot image and Chrome's own
 * screenshot of the same pane, and checks that each chart region has about as
 * much ink in the copy as on screen: an SVG gauge, canvas charts, an SVG chart,
 * a toolbar laid over a canvas by z-index, and the gradients and
 * masked icons charts draw with CSS. Both device pixel
 * ratios are checked, the 2x one being a Retina Mac.
 *
 * The image an assistant gets through pane.screenshot is the same
 * paint at its own size; the check also holds it to its bounds: twice the
 * on-screen size within the long edge, and shrunk under a byte cap that the
 * first paint overshoots, or refused when even the narrowest image would not fit.
 *
 *   bun run check:pane-screenshot [--root <checkout>] [--out <dir>]
 *
 * `--out` keeps both images of every pane for a look; on failure they are kept
 * under the cache folder (`PANE_CHROME_CACHE`, default ~/.cache/gloomberb-pane-chrome).
 */

const VIEWPORT = { width: 1400, height: 900 };
/**
 * The copy may differ in antialiasing and text, never in whole shapes: a
 * missing shape has far less ink than the screen, an unmasked one far more.
 */
const MIN_INK_RATIO = 0.6;
const MAX_INK_RATIO = 1.6;
/** Edges antialias a little differently; a shape in the wrong place or colour differs everywhere. */
const MAX_DIFFERING = 0.3;
/** A region with less ink on screen than this did not render, so it proves nothing. */
const MIN_SCREEN_INK = 150;

interface Rect { x: number; y: number; width: number; height: number }
interface Region {
  pane: string;
  name: string;
  selector: string;
  /** Text: the copy sets glyphs a pixel or two off the screen's baseline, so only its ink counts. */
  text?: true;
}

const REGIONS: Region[] = [
  { pane: "fear-greed:a", name: "speedometer gauge (SVG)", selector: "svg[role=img]" },
  { pane: "fear-greed:a", name: "index history (canvas)", selector: "[data-gloom-role=composite-chart-panel]" },
  { pane: "charts:a", name: "line chart (canvas)", selector: "[data-shot-region=canvas-chart]" },
  { pane: "charts:a", name: "toolbar over the canvas (z-index)", selector: "[data-shot-region=canvas-overlay]" },
  { pane: "charts:a", name: "sparkline (SVG)", selector: "[data-shot-region=svg-chart] svg" },
  { pane: "charts:a", name: "dashed legend cue (repeating gradient)", selector: "[data-shot-region=dashed-cue]" },
  { pane: "charts:a", name: "colour scale (gradient)", selector: "[data-shot-region=colour-scale]" },
  { pane: "charts:a", name: "toolbar icon (SVG mask)", selector: "[data-shot-region=masked-icon]" },
  { pane: "charts:a", name: "grid rows (display: contents)", selector: "[data-shot-region=column-grid]", text: true },
];

/** Page side: ink in each region of the screen and of the copy, measured against the region's commonest colour. */
const MEASURE = `async (screen, copy, regions, scale) => {
  const pixels = async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  };
  const [live, shot] = [await pixels(screen), await pixels(copy)];
  const at = (image, x, y) => { const i = (y * image.width + x) * 4; return [image.data[i], image.data[i + 1], image.data[i + 2]]; };
  return regions.map((region) => {
    const x0 = Math.max(0, Math.round(region.x * scale)), y0 = Math.max(0, Math.round(region.y * scale));
    const x1 = Math.min(live.width, shot.width, Math.round((region.x + region.width) * scale));
    const y1 = Math.min(live.height, shot.height, Math.round((region.y + region.height) * scale));
    const counts = new Map();
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
      const key = at(live, x, y).join();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const background = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0].split(",").map(Number) ?? [0, 0, 0];
    const ink = (image) => {
      let count = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
        const [r, g, b] = at(image, x, y);
        if (Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]) > 48) count += 1;
      }
      return count;
    };
    // Pixels that differ between screen and copy, out of those inked in either.
    let differing = 0;
    let inked = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
      const a = at(live, x, y);
      const b = at(shot, x, y);
      const away = (c) => Math.abs(c[0] - background[0]) + Math.abs(c[1] - background[1]) + Math.abs(c[2] - background[2]) > 48;
      if (!away(a) && !away(b)) continue;
      inked += 1;
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 96) differing += 1;
    }
    return { screen: ink(live), copy: ink(shot), differing: inked ? differing / inked : 0 };
  });
}`;

interface Ink {
  /** Pixels away from the region's commonest colour, on screen and in the copy. */
  screen: number;
  copy: number;
  /** The share of pixels inked in either image that differ between them. */
  differing: number;
}
interface Result extends Ink { pane: string; name: string; scale: number; ok: boolean }

async function checkPanes(cdp: Cdp, scale: number, out: string | undefined): Promise<Result[]> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: scale, mobile: false });
  const results: Result[] = [];
  for (const pane of [...new Set(REGIONS.map((region) => region.pane))]) {
    const regions = REGIONS.filter((region) => region.pane === pane);
    const located = await evaluate<{ pane: Rect; regions: (Rect | null)[] }>(cdp, `(() => {
      const pane = document.querySelector('[data-gloom-role=pane-window][data-gloom-pane-id="${pane}"]');
      const box = pane.getBoundingClientRect();
      return {
        pane: { x: box.x, y: box.y, width: box.width, height: box.height },
        regions: ${JSON.stringify(regions.map((region) => region.selector))}.map((selector) => {
          const element = pane.querySelector(selector);
          if (!element) return null;
          const r = element.getBoundingClientRect();
          return { x: r.x - box.x, y: r.y - box.y, width: r.width, height: r.height };
        }),
      };
    })()`);
    const missing = regions.filter((_, index) => !located.regions[index]);
    if (missing.length > 0) throw new Error(`${pane} rendered no ${missing.map((region) => region.name).join(", ")}`);
    const copy = await evaluate<string>(cdp, `window.__paneChrome.capturePane(${JSON.stringify(pane)})`);
    const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      clip: { ...located.pane, scale: 1 },
    });
    const screen = `data:image/png;base64,${shot.data}`;
    const measured = await evaluate<Ink[]>(
      cdp,
      `(${MEASURE})(${JSON.stringify(screen)}, ${JSON.stringify(copy)}, ${JSON.stringify(located.regions)}, ${scale})`,
    );
    let failed = false;
    regions.forEach((region, index) => {
      const ink = measured[index]!;
      const ok = ink.screen >= MIN_SCREEN_INK * scale * scale
        && ink.copy >= ink.screen * MIN_INK_RATIO
        && ink.copy <= ink.screen * MAX_INK_RATIO
        && (region.text || ink.differing <= MAX_DIFFERING);
      failed ||= !ok;
      results.push({ pane, name: region.name, scale, ...ink, ok });
    });
    const dir = out ?? (failed ? cacheDir("failures") : undefined);
    if (dir) {
      await mkdir(dir, { recursive: true });
      const base = join(dir, `${pane.replace(/[^a-z0-9]+/gi, "-")}@${scale}x`);
      await Bun.write(`${base}-screen.png`, Buffer.from(shot.data, "base64"));
      await Bun.write(`${base}-copy.png`, Buffer.from(copy.slice(copy.indexOf(",") + 1), "base64"));
      console.log(`     images: ${base}-{screen,copy}.png`);
    }
  }
  return results;
}

interface Shot { width: number; height: number; bytes: number; reduced: boolean; screen: { width: number; height: number } }
interface SizeResult { pane: string; name: string; detail: string; ok: boolean }

/** pane.screenshot's bounds, in the real browser's PNG encoder. */
async function checkAssistantSizes(cdp: Cdp): Promise<SizeResult[]> {
  const results: SizeResult[] = [];
  const describe = (shot: Shot | { error: string }) => ("error" in shot ? shot.error : `${shot.width}x${shot.height}, ${shot.bytes} bytes${shot.reduced ? ", shrunk" : ""}`);
  for (const pane of [...new Set(REGIONS.map((region) => region.pane))]) {
    const screen = await evaluate<{ width: number; height: number }>(cdp, `(() => {
      const box = document.querySelector('[data-gloom-role=pane-window][data-gloom-pane-id="${pane}"]').getBoundingClientRect();
      return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
    })()`);
    // The scale pane.screenshot picks by default: twice the screen, within the long edge.
    const scale = paneScreenshotScale(screen);
    const capture = (maxBytes: number) => evaluate<Shot | { error: string }>(
      cdp,
      `window.__paneChrome.captureForAssistant(${JSON.stringify(pane)}, ${scale}, ${maxBytes}, ${PANE_SCREENSHOT_MIN_WIDTH})`,
    );
    const first = await capture(PANE_SCREENSHOT_MAX_BYTES);
    results.push({
      pane,
      name: "default size",
      detail: describe(first),
      ok: !("error" in first) && !first.reduced && first.bytes <= PANE_SCREENSHOT_MAX_BYTES
        && Math.abs(first.width - screen.width * scale) <= 1
        && Math.max(first.width, first.height) <= PANE_SCREENSHOT_MAX_EDGE,
    });
    if ("error" in first) continue;
    const cap = Math.floor(first.bytes / 3);
    const shrunk = await capture(cap);
    results.push({
      pane,
      name: `shrunk under ${cap} bytes`,
      detail: describe(shrunk),
      ok: !("error" in shrunk) && shrunk.reduced && shrunk.bytes <= cap
        && shrunk.width < first.width && shrunk.width >= PANE_SCREENSHOT_MIN_WIDTH,
    });
    const refused = await capture(500);
    results.push({ pane, name: "refused under 500 bytes", detail: describe(refused), ok: "error" in refused && refused.error.includes("stays over") });
  }
  return results;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
  const out = takeOption(args, "--out");
  const page = await serveFixturePage(root, cacheDir("build", `screenshot-${process.pid}`));
  const browser = await launchBrowser("screenshot", VIEWPORT.width, VIEWPORT.height);
  const { cdp } = browser;
  const results: Result[] = [];
  let sizes: SizeResult[] = [];
  try {
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: new URL("?scenario=screenshot", page.url).href });
    await loaded;
    // Ready once the shell laid out and every chart region is there.
    const ready = `window.__paneChrome?.ready === true && ${JSON.stringify(REGIONS)}.every((region) => document.querySelector('[data-gloom-pane-id="' + region.pane + '"] ' + region.selector))`;
    if (!await waitFor(cdp, ready, 15_000)) {
      throw new Error(`the screenshot fixture did not render: ${await evaluate(cdp, "document.body.innerText.slice(0, 400)")}`);
    }
    for (const scale of [1, 2]) results.push(...await checkPanes(cdp, scale, out));
    sizes = await checkAssistantSizes(cdp);
    if (page.strayRequests.length > 0) throw new Error(`the fixture requested files it does not have: ${page.strayRequests.join(", ")}`);
  } finally {
    await browser.close();
    await page.close();
  }

  for (const result of results) {
    console.log(`${result.ok ? "ok  " : "FAIL"} ${result.pane} ${result.name} @${result.scale}x: ink ${result.copy} in the copy, ${result.screen} on screen, ${percent(result.differing)} differing`);
  }
  for (const size of sizes) {
    console.log(`${size.ok ? "ok  " : "FAIL"} ${size.pane} pane.screenshot ${size.name}: ${size.detail}`);
  }
  const failures = results.filter((result) => !result.ok);
  const sizeFailures = sizes.filter((size) => !size.ok);
  const summary = [
    "### Pane screenshot check",
    "",
    "| | Pane | Region | Scale | Ink on screen | Ink in the copy | Differing |",
    "|---|---|---|---|---|---|---|",
    ...results.map((result) => `| ${result.ok ? "ok" : "**failed**"} | ${result.pane} | ${result.name} | ${result.scale}x | ${result.screen} | ${result.copy} | ${percent(result.differing)} |`),
    "",
    "| | Pane | pane.screenshot | Image |",
    "|---|---|---|---|",
    ...sizes.map((size) => `| ${size.ok ? "ok" : "**failed**"} | ${size.pane} | ${size.name} | ${size.detail} |`),
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  for (const failure of failures) {
    const message = `${failure.pane} ${failure.name} at ${failure.scale}x: ink ${failure.copy} in the copy, ${failure.screen} on screen, ${percent(failure.differing)} differing`;
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Pane screenshot::${message}`);
  }
  for (const size of sizeFailures) {
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Pane screenshot::${size.pane} pane.screenshot ${size.name}: ${size.detail}`);
  }
  if (failures.length > 0 || sizeFailures.length > 0) process.exitCode = 1;
}

await main();
