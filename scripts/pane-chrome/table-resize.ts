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
const startedAt = new Date().toISOString();
const sources: Record<string, { sha: string; dirty: boolean }> = {};
const reports: Array<{ side: string; kind: string; width: number; theme: string; maxShift: number; shifts: Array<{ name: string; shift: number }>; live: { frames: number; maxShift: number }; release: { travel: number; maxStep: number; maxStepPerFrame: number } }> = [];
const rest: Array<{ kind: string; width: number; theme: string; comparison: ReturnType<typeof pixelChange>; releasedComparison: ReturnType<typeof pixelChange>; exactPixels: number; releasedPixels: number }> = [];
function sourceState(checkout: string): { sha: string; dirty: boolean } {
  const git = (args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  return { sha: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" };
}
function differentPixels(before: string, after: string): number {
  const exact = Bun.spawnSync(["compare", "-regard-warnings", "-metric", "AE", before, after, "null:"]);
  if (exact.exitCode !== 0 && exact.exitCode !== 1) throw new Error(exact.stderr.toString());
  const count = exact.stderr.toString().trim();
  if (!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(count) || !Number.isFinite(Number(count))) {
    throw new Error(`Exact comparison gave no pixel count: ${JSON.stringify(count)}`);
  }
  return Number(count);
}
for (const [side, checkout] of ([...(base ? [["base", resolve(base)]] : []), ["head", root]] as Array<[string, string]>).filter(([side]) => !sideOnly || side === sideOnly)) {
  sources[side] = sourceState(checkout);
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
            const beforeReleased = join(out, `${kind}-${width}-${theme}-base-released.png`);
            const afterReleased = join(out, `${prefix}-released.png`);
            rest.push({ kind, width, theme, comparison: pixelChange(before, after), exactPixels: differentPixels(before, after),
              releasedComparison: pixelChange(beforeReleased, afterReleased), releasedPixels: differentPixels(beforeReleased, afterReleased) });
            const pair = Bun.spawnSync(["montage", join(out, `${kind}-${width}-${theme}-base-rest.png`), join(out, `${prefix}-rest.png`), "-thumbnail", "640x", "-tile", "2x1", "-geometry", "+4+4", join(out, `${kind}-${width}-${theme}-rest-pair.jpg`)]);
            if (pair.exitCode !== 0) throw new Error(pair.stderr.toString());
          }
        }
      } finally { await browser.close(); }
    }
  } finally { await page.close(); }
}
const failures = [
  ...reports.filter((report) => report.side === "head" && (report.maxShift > 1 || report.release.maxStepPerFrame > 3))
    .map((report) => `${report.kind} ${report.width}px ${report.theme}: resize geometry moved beyond its limit`),
  ...rest.flatMap((pair) => ([["initial", pair.comparison], ["released", pair.releasedComparison]] as const)
    .filter(([, comparison]) => comparison.status !== "compared" || comparison.change > 0)
    .map(([state, comparison]) => `${pair.kind} ${pair.width}px ${pair.theme}: ${state} rest differs or could not be compared: ${JSON.stringify(comparison)}`)),
];
await Bun.write(join(out, "report.json"), JSON.stringify({ startedAt, completedAt: new Date().toISOString(), sources, reports, rest, failures }, null, 2));
console.log(`Captures and report: ${out}`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
