import { mkdir } from "fs/promises";
import { join, resolve } from "path";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir, evaluate, frames, launchBrowser, sleep, waitFor, type Cdp } from "./browser";
import { serveFixturePage, type FixturePage } from "./page";

/**
 * Panes at rest, pixel for pixel, against a base checkout: each fixture layout
 * (fixture.tsx) drawn by both checkouts in the same headless Chrome, at the
 * same size, compared pixel by pixel. Reports how many pixels differ, in which
 * pane and where, and saves the base, head and diff images of every layout
 * that differs under the cache folder.
 *
 *   bun run check:pane-rest --base <checkout> [--head <checkout>] [--width 1440] [--height 900]
 *
 * A difference is not a failure by itself: the report says where it is, and
 * a change that means to draw something differently says why in its PR.
 */

const LAYOUTS: Array<{ name: string; query: string }> = [
  { name: "docked (plain, tabbed, failed panes)", query: "scenario=docked" },
  { name: "floating", query: "scenario=floating" },
  { name: "popped-out window", query: "scenario=detached" },
  { name: "popped-out window (Windows)", query: "scenario=detached&platform=win32" },
  { name: "news table, chart, table with sidebar, table, floating news table", query: "scenario=resize" },
  { name: "floating chart", query: "scenario=resize&float=chart" },
  { name: "floating heat map", query: "scenario=resize&float=heat" },
  { name: "market heat map of 500 names, docked and floating", query: "scenario=resize&float=heat&heat=market&dock=heat" },
  { name: "floating Fear & Greed", query: "scenario=resize&float=fear" },
  { name: "Fear & Greed and canvas charts", query: "scenario=screenshot" },
  { name: "charts inside a pane's layout, docked (G layout, board, beside a table, under a toolbar)", query: "scenario=nested" },
  { name: "floating G layout", query: "scenario=resize&float=g" },
  { name: "floating board (tabs, query bar, chart band, table)", query: "scenario=resize&float=board" },
  { name: "floating chart beside a table", query: "scenario=resize&float=beside" },
  { name: "floating chart under a toolbar", query: "scenario=resize&float=overlay" },
  { name: "floating chart under a table", query: "scenario=resize&float=under" },
  { name: "chart under a table beside a chart, docked", query: "scenario=stacked" },
  { name: "chat beside a plain pane", query: "scenario=chat" },
  { name: "DES overview beside a plain pane", query: "scenario=des" },
];

interface PaneRect { id: string; x: number; y: number; width: number; height: number }

interface Shot { png: string; panes: PaneRect[] }

interface Diff {
  pixels: number;
  /** Differing pixels by the pane they fall in ("outside panes" otherwise), with their bounding box. */
  regions: Array<{ where: string; pixels: number; box: { x: number; y: number; width: number; height: number } }>;
  /** Red where the two differ, over the head image dimmed; null when they do not. */
  image: string | null;
}

async function shoot(cdp: Cdp, page: FixturePage, query: string): Promise<Shot> {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: new URL(`?${query}`, page.url).href });
  await loaded;
  if (!await waitFor(cdp, "window.__paneChrome?.ready === true", 15_000)) throw new Error(`the ${query} fixture did not render`);
  // Anything measured after the first layout (a canvas drawn at its measured size) has drawn.
  await frames(cdp, 10);
  await sleep(400);
  await frames(cdp, 4);
  const panes = await evaluate<PaneRect[]>(cdp, `[...document.querySelectorAll("[data-gloom-pane-id]")].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.getAttribute("data-gloom-pane-id"), x: r.x, y: r.y, width: r.width, height: r.height };
  })`);
  const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  return { png: data, panes };
}

/** Compares two PNGs in the page: no image library needed on either side. */
async function compare(cdp: Cdp, base: string, head: string, panes: PaneRect[]): Promise<Diff> {
  return evaluate<Diff>(cdp, `(async () => {
    const load = async (png) => createImageBitmap(await (await fetch("data:image/png;base64," + png)).blob());
    const [a, b] = await Promise.all([load(${JSON.stringify(base)}), load(${JSON.stringify(head)})]);
    const width = Math.max(a.width, b.width);
    const height = Math.max(a.height, b.height);
    const pixelsOf = (bitmap) => {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, width, height).data;
    };
    const pa = pixelsOf(a);
    const pb = pixelsOf(b);
    const panes = ${JSON.stringify(panes)};
    const regions = new Map();
    let pixels = 0;
    const out = new OffscreenCanvas(width, height);
    const context = out.getContext("2d");
    context.drawImage(b, 0, 0);
    context.fillStyle = "rgba(0, 0, 0, 0.7)";
    context.fillRect(0, 0, width, height);
    const marks = context.getImageData(0, 0, width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (pa[i] === pb[i] && pa[i + 1] === pb[i + 1] && pa[i + 2] === pb[i + 2] && pa[i + 3] === pb[i + 3]) continue;
        pixels += 1;
        marks.data[i] = 255; marks.data[i + 1] = 40; marks.data[i + 2] = 40; marks.data[i + 3] = 255;
        // The topmost pane under the pixel: floating panes come after docked ones in the document.
        let where = "outside panes";
        for (const pane of panes) {
          if (x >= pane.x && x < pane.x + pane.width && y >= pane.y && y < pane.y + pane.height) where = pane.id;
        }
        const region = regions.get(where) ?? { where, pixels: 0, x0: x, y0: y, x1: x, y1: y };
        region.pixels += 1;
        region.x0 = Math.min(region.x0, x); region.y0 = Math.min(region.y0, y);
        region.x1 = Math.max(region.x1, x); region.y1 = Math.max(region.y1, y);
        regions.set(where, region);
      }
    }
    let image = null;
    if (pixels > 0) {
      context.putImageData(marks, 0, 0);
      const blob = await out.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      image = btoa(binary);
    }
    return {
      pixels,
      regions: [...regions.values()].map((r) => ({ where: r.where, pixels: r.pixels, box: { x: r.x0, y: r.y0, width: r.x1 - r.x0 + 1, height: r.y1 - r.y0 + 1 } })),
      image,
    };
  })()`, 120_000);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseRoot = takeOption(args, "--base");
  if (!baseRoot) throw new Error("Usage: rest-diff.ts --base <checkout> [--head <checkout>] [--width 1440] [--height 900]");
  const width = Number(takeOption(args, "--width") ?? 1440);
  const height = Number(takeOption(args, "--height") ?? 900);
  const outDir = cacheDir("rest-diff");
  await mkdir(outDir, { recursive: true });
  const base = await serveFixturePage(resolve(baseRoot), cacheDir("build", `rest-base-${process.pid}`), { ownFixtureFallback: true });
  const head = await serveFixturePage(resolve(takeOption(args, "--head") ?? join(import.meta.dir, "../..")), cacheDir("build", `rest-head-${process.pid}`));
  const browser = await launchBrowser("rest-diff", width, height);
  const lines = [
    "### Panes at rest against main",
    "",
    `Each fixture layout drawn by both checkouts in headless Chrome at ${width} by ${height}, compared pixel by pixel.${base.ownFixture ? " Main was drawn from its own fixture." : ""}`,
    "",
    "| Layout | Pixels that differ | Where |",
    "|---|---|---|",
  ];
  try {
    for (const layout of LAYOUTS) {
      const before = await shoot(browser.cdp, base, layout.query);
      const after = await shoot(browser.cdp, head, layout.query);
      const diff = await compare(browser.cdp, before.png, after.png, after.panes);
      const where = diff.regions
        .sort((left, right) => right.pixels - left.pixels)
        .map((region) => `${region.where}: ${region.pixels} px in ${region.box.width} by ${region.box.height} at (${region.box.x}, ${region.box.y})`)
        .join("; ");
      lines.push(`| ${layout.name} | ${diff.pixels} | ${where || "nothing"} |`);
      if (diff.image) {
        const slug = layout.query.replace(/[^a-z0-9]+/gi, "-");
        await Bun.write(join(outDir, `${slug}-base.png`), Buffer.from(before.png, "base64"));
        await Bun.write(join(outDir, `${slug}-head.png`), Buffer.from(after.png, "base64"));
        await Bun.write(join(outDir, `${slug}-diff.png`), Buffer.from(diff.image, "base64"));
      }
      console.error(`${layout.name}: ${diff.pixels} px differ`);
    }
  } finally {
    await browser.close();
    await base.close();
    await head.close();
  }
  lines.push("", `Images of every layout that differs: ${outDir}`);
  console.log(lines.join("\n"));
}

await main();
