import { mkdir } from "fs/promises";
import { join, resolve } from "path";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir, launchBrowser, waitFor } from "./browser";
import { serveFixturePage } from "./page";
import { checkTableResize, TABLE_RESIZE_KINDS } from "./table-resize-checks";
import { pixelChange } from "./ui-audit-compare";

/**
 * Loaded VOLS, HP and SEAS, with invented observations: real pointer resizes,
 * first-frame/catch-up geometry, and before/after rest and resize captures.
 *
 * bun scripts/pane-chrome/table-resize.ts --base <checkout> [--out <dir>]
 *   [--root <checkout>] [--widths 640,1280] [--themes white,paper]
 *
 * Writes each resize's frames, contact sheets, and the measured report. The
 * head must shift no cell or text more than a pixel at the deferred catch-up.
 */
const args = process.argv.slice(2);
const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
const base = takeOption(args, "--base");
const out = resolve(takeOption(args, "--out") ?? cacheDir("table-resize"));
const widths = (takeOption(args, "--widths") ?? "640,1280").split(",").map(Number);
const themes = (takeOption(args, "--themes") ?? "white,paper").split(",");
const only = takeOption(args, "--only");
const sideOnly = takeOption(args, "--side");
await mkdir(out, { recursive: true });
const reports: Array<{ side: string; kind: string; width: number; theme: string; maxShift: number; shifts: Array<{ name: string; shift: number }>; live: { frames: number; maxShift: number }; release: { travel: number; maxStep: number; maxStepPerFrame: number } }> = [];
const rest: Array<{ kind: string; width: number; theme: string; comparison: ReturnType<typeof pixelChange>; exactPixels: number; releasedPixels: number }> = [];
function differentPixels(before: string, after: string): number {
  const exact = Bun.spawnSync(["compare", "-metric", "AE", before, after, "null:"]);
  if (exact.exitCode !== 0 && exact.exitCode !== 1) throw new Error(exact.stderr.toString());
  return Number(exact.stderr.toString().trim());
}
for (const [side, checkout] of ([...(base ? [["base", resolve(base)]] : []), ["head", root]] as Array<[string, string]>).filter(([side]) => !sideOnly || side === sideOnly)) {
  const page = await serveFixturePage(checkout, cacheDir("build", `table-resize-${side}-${process.pid}`));
  try {
    for (const width of widths) {
      const browser = await launchBrowser(`table-resize-${side}`, width, 800);
      try {
        for (const theme of themes) for (const kind of TABLE_RESIZE_KINDS.filter((kind) => !only || kind === only)) {
          const cdp = browser.cdp;
          const loaded = cdp.once("Page.loadEventFired");
          await cdp.send("Page.navigate", { url: new URL(`?scenario=table-resize&pane=${kind}&theme=${theme}&mode=float`, page.url).href });
          await loaded;
          if (!await waitFor(cdp, "window.__paneChrome?.ready === true", 15_000)) throw new Error("Fixture did not mount");
          const prefix = `${kind}-${width}-${theme}-${side}`;
          const result = await checkTableResize(cdp, kind, "float", async (name) => {
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
            await Bun.write(join(out, `${prefix}-${name}.png`), Buffer.from(data, "base64"));
          });
          const shifts = result.results.map(({ name, shift }) => ({ name, shift }));
          reports.push({ side, kind, width, theme, maxShift: result.maxShift, shifts, live: result.live, release: result.release });
          console.log(`${side} ${kind} ${width}px ${theme}: ${JSON.stringify(shifts)}; live ${JSON.stringify(result.live)}; release ${JSON.stringify(result.release)}`);
          const sequence = ["rest", "in-13", "in-29", "in-61", "released"].map((name) => join(out, `${prefix}-${name}.png`));
          const sheet = Bun.spawnSync(["montage", ...sequence, "-thumbnail", "384x", "-tile", "5x1", "-geometry", "+4+4", join(out, `${prefix}-sequence.jpg`)]);
          if (sheet.exitCode !== 0) throw new Error(sheet.stderr.toString());
          if (side === "head" && base) {
            const before = join(out, `${kind}-${width}-${theme}-base-rest.png`);
            const after = join(out, `${prefix}-rest.png`);
            rest.push({ kind, width, theme, comparison: pixelChange(before, after), exactPixels: differentPixels(before, after),
              releasedPixels: differentPixels(join(out, `${kind}-${width}-${theme}-base-released.png`), join(out, `${prefix}-released.png`)) });
            const pair = Bun.spawnSync(["montage", join(out, `${kind}-${width}-${theme}-base-rest.png`), join(out, `${prefix}-rest.png`), "-thumbnail", "640x", "-tile", "2x1", "-geometry", "+4+4", join(out, `${kind}-${width}-${theme}-rest-pair.jpg`)]);
            if (pair.exitCode !== 0) throw new Error(pair.stderr.toString());
          }
        }
      } finally { await browser.close(); }
    }
  } finally { await page.close(); }
}
await Bun.write(join(out, "report.json"), JSON.stringify({ reports, rest }, null, 2));
console.log(`Captures and report: ${out}`);
if (reports.some((report) => report.side === "head" && (report.maxShift > 1 || report.release.maxStepPerFrame > 3))) process.exitCode = 1;
