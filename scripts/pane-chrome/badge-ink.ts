import { mkdir, readdir } from "fs/promises";
import { join, resolve } from "path";
import { Jimp } from "jimp";
import { takeOption } from "../tui-benchmark-harness";
import type { BadgeInkLayout } from "./badge-ink-fixture";
import { cacheDir, evaluate, launchBrowser, sleep } from "./browser";
import { FIXTURE, buildFixture, serveFixturePage } from "./page";

/**
 * Where a chip's icon and label sit, measured from the pixels people see:
 * the ink of the icon, of the label's x-height letters, of its capitals and
 * digits and of the whole label, and the chip's fill, each as a box whose
 * antialiased edges count as the part of a pixel they cover. Font metrics
 * (ex, cap, ascent) say where a font means its letters to go, not where
 * they land, and they differ by font: SF Mono on a Mac, Liberation Mono or
 * DejaVu on Linux, Consolas on Windows. So a question of alignment is
 * answered here, in the font it is asked about.
 *
 *   bun run ui:badge-ink [--engines chromium,webkit,wkwebview] [--themes white,paper,amber] [--font 12] [--out <dir>] [--crops]
 *   bun run ui:badge-ink page <dir>                 the built page, to picture in another browser
 *   bun run ui:badge-ink measure <dir> [--crops]    measure pictures taken elsewhere (<name>.png + <name>.json)
 *
 * Engines: `chromium` (the pinned headless shell, as the web app draws),
 * `webkit` (Playwright's WebKit) and `wkwebview`, macOS only: the system
 * WebKit and fonts the desktop app draws with, through
 * wkwebview-snapshot.swift. Pictures are at device scale 2. The page is the
 * `badge-ink` fixture scenario (badge-ink-fixture.tsx). To measure a Mac
 * from elsewhere, `page` builds it, any static server on the Mac serves it,
 * `swift wkwebview-snapshot.swift "<url>?scenario=badge-ink&theme=white&font=12" 360x400 <dir>/wkwebview-white-12px`
 * takes the picture, and `measure <dir>` reads it.
 *
 * The table gives each chip's centres in device pixels against its fill's
 * centre (+ is lower): the icon's ink, the x-height letters', the capitals'
 * and the whole label's, then the icon against the x-height letters. An
 * icon reads on the label's line when that is within half a pixel, and a
 * label reads centred when its x-height letters (capitals, for a label
 * without lowercase) are. `--crops` writes each chip at 4x, the 2x picture
 * doubled without smoothing.
 */

const VIEWPORT = { width: 360, height: 400 };
const SCALE = 2;
/** Letters that keep to the x-height: no ascender, no descender, no dot. */
const X_HEIGHT = new Set("acemnorsuvwxz");
const CAPITALS = /[A-Z0-9]/;
/** Coverage below this is the fill's own antialiasing, not ink. */
const INK_FLOOR = 0.08;

interface Box { top: number; bottom: number; left: number; right: number }
interface Rgb { r: number; g: number; b: number }

export interface ChipInk {
  id: string;
  /** Device pixels from the top left of the picture. */
  chip: Box;
  icon: Box | null;
  xHeight: Box | null;
  capitals: Box | null;
  label: Box | null;
}

/** An RGBA picture, read a pixel at a time; reads past an edge take the edge. */
export class Picture {
  constructor(readonly width: number, readonly height: number, private readonly data: Uint8Array) {}

  pixel(x: number, y: number): Rgb {
    const at = (Math.min(this.height - 1, Math.max(0, y)) * this.width + Math.min(this.width - 1, Math.max(0, x))) * 4;
    return { r: this.data[at]!, g: this.data[at + 1]!, b: this.data[at + 2]! };
  }
}

/** How far `pixel` lies from `from` toward `to`: 0 is `from`, 1 is `to`. */
function coverage(pixel: Rgb, from: Rgb, to: Rgb): number {
  const [dr, dg, db] = [to.r - from.r, to.g - from.g, to.b - from.b];
  const length = dr * dr + dg * dg + db * db;
  if (length === 0) return 0;
  return Math.min(1, Math.max(0, ((pixel.r - from.r) * dr + (pixel.g - from.g) * dg + (pixel.b - from.b) * db) / length));
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, index) => from + index);
}

/**
 * The box of what is drawn in `to` over `from` in the given columns and
 * rows: an outermost row or column whose strongest pixel is covered by `c`
 * moves that edge in by `1 - c`, so an antialiased edge lands where the
 * shape's edge is, between pixels, not on the pixel grid.
 */
function inkBox(picture: Picture, columns: number[], top: number, bottom: number, from: Rgb, to: Rgb): Box | null {
  const rows: number[] = [];
  const cols = new Map<number, number>();
  for (let y = top; y < bottom; y += 1) {
    let strongest = 0;
    for (const x of columns) {
      const c = coverage(picture.pixel(x, y), from, to);
      strongest = Math.max(strongest, c);
      if (c > INK_FLOOR) cols.set(x, Math.max(cols.get(x) ?? 0, c));
    }
    rows.push(strongest);
  }
  const first = rows.findIndex((c) => c > INK_FLOOR);
  if (first < 0) return null;
  const last = rows.findLastIndex((c) => c > INK_FLOOR);
  const xs = [...cols.keys()].sort((a, b) => a - b);
  return {
    top: top + first + 1 - rows[first]!,
    bottom: top + last + rows[last]!,
    left: xs[0]! + 1 - cols.get(xs[0]!)!,
    right: xs.at(-1)! + cols.get(xs.at(-1)!)!,
  };
}

export function measureChips(picture: Picture, layout: BadgeInkLayout): ChipInk[] {
  const s = picture.width / layout.viewport.width;
  const columnsOf = (boxes: { x: number; width: number }[]) =>
    // A pixel in from each side of a character's advance, clear of its neighbours' ink.
    boxes.flatMap((box) => range(Math.round(box.x * s) + 1, Math.round((box.x + box.width) * s) - 1));
  return layout.specimens.map((specimen) => {
    const { chip } = specimen;
    const [x0, y0, x1, y1] = [chip.x, chip.y, chip.x + chip.width, chip.y + chip.height].map((value) => Math.round(value * s)) as [number, number, number, number];
    const middle = Math.round((y0 + y1) / 2);
    const page = picture.pixel(x0 - 3 * s, middle);
    // The left padding: inside the fill, clear of the rounded corners and of the ink.
    const padding = range(x0 + 3 * s, x0 + 6 * s);
    const fill = picture.pixel(padding[0]!, middle);
    const fillBox = distance(page, fill) < 4 ? null : inkBox(picture, padding, y0 - 3 * s, y1 + 3 * s, page, fill);
    // Ink is looked for inside the fill only: past its edge, the page can be the ink's own colour (a solid chip).
    const [top, bottom] = fillBox ? [Math.ceil(fillBox.top) + 1, Math.floor(fillBox.bottom) - 1] : [y0, y1];
    const glyphs = specimen.chars.filter(({ char }) => char.trim());
    const labelColumns = columnsOf(glyphs.map(({ box }) => box));
    const iconColumns = specimen.icon ? range(Math.round(specimen.icon.x * s) - 1, Math.round((specimen.icon.x + specimen.icon.width) * s) + 1) : [];
    // The ink's colour: the label's pixel furthest from the fill, or the icon's when there is no label.
    let ink = fill;
    for (let y = top; y < bottom; y += 1) {
      for (const x of labelColumns.length ? labelColumns : iconColumns) {
        const pixel = picture.pixel(x, y);
        if (distance(pixel, fill) > distance(ink, fill)) ink = pixel;
      }
    }
    const box = (columns: number[]) => columns.length ? inkBox(picture, columns, top, bottom, fill, ink) : null;
    const of = (keep: (char: string) => boolean) => columnsOf(glyphs.filter(({ char }) => keep(char)).map(({ box: advance }) => advance));
    return {
      id: specimen.id,
      chip: fillBox ?? { top: y0, bottom: y1, left: x0, right: x1 },
      icon: box(iconColumns),
      xHeight: box(of((char) => X_HEIGHT.has(char))),
      capitals: box(of((char) => CAPITALS.test(char))),
      label: box(labelColumns),
    };
  });
}

const centre = (box: Box) => (box.top + box.bottom) / 2;
const signed = (value: number | null) => value === null ? "" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;

/** One row per chip: centres in device pixels against the fill's centre. */
export function inkTable(chips: ChipInk[]): string {
  const lines = [
    "| chip | icon | x-height | capitals | label | icon - x-height | letters top / baseline |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const chip of chips) {
    const middle = centre(chip.chip);
    const from = (box: Box | null) => box ? centre(box) - middle : null;
    const letters = chip.xHeight ?? chip.capitals;
    lines.push(`| ${[
      chip.id,
      signed(from(chip.icon)),
      signed(from(chip.xHeight)),
      signed(from(chip.capitals)),
      signed(from(chip.label)),
      signed(chip.icon && chip.xHeight ? centre(chip.icon) - centre(chip.xHeight) : null),
      letters ? `${(letters.top - chip.chip.top).toFixed(2)} / ${(letters.bottom - chip.chip.top).toFixed(2)} of ${(chip.chip.bottom - chip.chip.top).toFixed(2)}` : "",
    ].join(" | ")} |`);
  }
  lines.push("", "Device pixels at 2x, against the centre of the chip's fill; + is lower. Letters: the x-height letters (else the capitals) below the fill's top.");
  return lines.join("\n");
}

/** Each chip and a little of the page around it, doubled without smoothing: 4x the CSS size. */
async function writeCrops(png: string, layout: BadgeInkLayout, prefix: string): Promise<void> {
  const image = await Jimp.read(png);
  const s = image.bitmap.width / layout.viewport.width;
  for (const { id, chip } of layout.specimens) {
    const crop = image.clone().crop({ x: Math.round((chip.x - 6) * s), y: Math.round((chip.y - 4) * s), w: Math.round((chip.width + 12) * s), h: Math.round((chip.height + 8) * s) });
    crop.resize({ w: crop.bitmap.width * 2, h: crop.bitmap.height * 2, mode: "nearestNeighbor" as never });
    await crop.write(`${prefix}-${id.replace(/[^a-z0-9]+/gi, "-").replace(/-$/, "")}.png` as `${string}.png`);
  }
}

async function measureDir(dir: string, crops: boolean): Promise<void> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json") && !name.endsWith(".ink.json")).map((name) => name.slice(0, -5)).sort();
  for (const name of names) {
    const png = join(dir, `${name}.png`);
    if (!await Bun.file(png).exists()) continue;
    const layout = await Bun.file(join(dir, `${name}.json`)).json() as BadgeInkLayout;
    const image = await Jimp.read(png);
    const chips = measureChips(new Picture(image.bitmap.width, image.bitmap.height, image.bitmap.data), layout);
    await Bun.write(join(dir, `${name}.ink.json`), JSON.stringify(chips, null, 1));
    console.log(`\n### ${name} (${image.bitmap.width}x${image.bitmap.height}, ${layout.fontSize} ${layout.fontFamily.split(",")[0]})\n\n${inkTable(chips)}`);
    if (crops) {
      await mkdir(join(dir, "crops"), { recursive: true });
      await writeCrops(png, layout, join(dir, "crops", name));
    }
  }
}

async function shoot(engine: string, url: string, out: string): Promise<void> {
  const { width, height } = VIEWPORT;
  if (engine === "wkwebview") {
    if (process.platform !== "darwin") throw new Error("wkwebview is the macOS system WebKit: run it on a Mac, or picture `page` there and `measure` here.");
    const run = Bun.spawnSync(["swift", join(import.meta.dir, "wkwebview-snapshot.swift"), url, `${width}x${height}`, out], { stdout: "inherit", stderr: "inherit" });
    if (run.exitCode !== 0) throw new Error(`wkwebview-snapshot.swift failed on ${url}`);
    return;
  }
  if (engine === "webkit") {
    const { webkit } = await import("playwright-core");
    const browser = await webkit.launch({ headless: true });
    try {
      const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: SCALE })).newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.__badgeInk?.ready === true, null, { timeout: 30_000 });
      await Bun.write(`${out}.json`, JSON.stringify(await page.evaluate(() => window.__badgeInk)));
      await page.screenshot({ path: `${out}.png` });
    } finally {
      await browser.close();
    }
    return;
  }
  if (engine !== "chromium") throw new Error(`Unknown engine ${engine}: chromium, webkit or wkwebview.`);
  const browser = await launchBrowser("badge-ink", width, height);
  try {
    const { cdp } = browser;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: SCALE, mobile: false });
    await cdp.send("Page.navigate", { url });
    for (let tries = 0; tries < 300 && !await evaluate<boolean>(cdp, "window.__badgeInk?.ready === true").catch(() => false); tries += 1) await sleep(100);
    await Bun.write(`${out}.json`, JSON.stringify(await evaluate(cdp, "window.__badgeInk")));
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    await Bun.write(`${out}.png`, Buffer.from(data, "base64"));
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
  const crops = args.includes("--crops");
  if (args[0] === "measure") return measureDir(resolve(args[1] ?? "."), crops);
  if (args[0] === "page") {
    const dir = resolve(args[1] ?? cacheDir("badge-ink", "page"));
    await buildFixture(root, FIXTURE, dir);
    console.log(`${dir}: serve it and open /?scenario=badge-ink&theme=<id>&font=<px>`);
    return;
  }
  const engines = (takeOption(args, "--engines") ?? "chromium").split(",");
  const themes = (takeOption(args, "--themes") ?? "white,paper,amber").split(",");
  const font = takeOption(args, "--font") ?? "12";
  const out = resolve(takeOption(args, "--out") ?? cacheDir("badge-ink", "run"));
  await mkdir(out, { recursive: true });
  const page = await serveFixturePage(root, cacheDir("badge-ink", "build"));
  try {
    for (const engine of engines) {
      for (const theme of themes) await shoot(engine, `${page.url.href}?scenario=badge-ink&theme=${theme}&font=${font}`, join(out, `${engine}-${theme}-${font}px`));
    }
  } finally {
    await page.close();
  }
  await measureDir(out, crops);
  console.log(`\n${out}`);
}

if (import.meta.main) await main();
