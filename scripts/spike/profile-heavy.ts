import { mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { launchBrowser, sleep, evaluate } from "../pane-chrome/browser";
import { readFileSync, existsSync } from "fs";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { createReplay, serveWebApp, settle } from "../pane-chrome/web-app";
import { heavyLayout } from "./layouts";

/**
 *   bun scripts/spike/profile-heavy.ts [--dist dist/web] [--replay <dir>] [--offline] [--out <dir>]
 *
 * Loads the heavy layout (scripts/spike/layouts.ts) in the web build in
 * headless Chrome and records a CPU profile of the page's main thread in
 * three phases: the launch until the layout has settled, a series of window
 * resizes (every chart lays out and redraws), and wheel zooms over the charts.
 * Writes each phase's .cpuprofile and a table of the functions with the most
 * self time, by phase and overall, and the same time grouped by area of the
 * source. Build the web app with `--keep-names --sourcemap` first so the
 * tables name functions and source files.
 *
 * The page gets its layout through localStorage only: the sweep's fixed clock
 * replaces Date with a JS subclass, which would bill every `new Date()` to
 * the harness.
 */

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dist = resolve(option("--dist") ?? "dist/web");
const replayDir = resolve(option("--replay") ?? join(process.env.HOME ?? ".", ".cache", "gloom-smoke", "spike-profile", "replay"));
const outDir = resolve(option("--out") ?? "spike-profile");
const offline = args.includes("--offline");
const width = 1920;
const height = 1080;

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; hitCount?: number; children?: number[] }
interface Profile { nodes: ProfileNode[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] }

const maps = new Map<string, TraceMap | null>();
function sourceOf(url: string, line: number, column: number): string | null {
  if (!url.includes("/assets/") || line < 0 || column < 0) return null;
  const path = join(dist, new URL(url).pathname);
  if (!maps.has(path)) maps.set(path, existsSync(`${path}.map`) ? new TraceMap(readFileSync(`${path}.map`, "utf8")) : null);
  const map = maps.get(path);
  if (!map) return null;
  const position = originalPositionFor(map, { line: line + 1, column });
  return position.source ? position.source.replace(/^(\.\.\/)+/, "") : null;
}

/** Areas of the source, first match wins. */
const AREAS: Array<[string, RegExp]> = [
  ["chart raster (composite/rasterizer, native/raster, paint)", /components\/chart\/(composite\/(rasterizer|volume-profile-paint|session-shading)|native\/raster)/],
  ["chart scene + axes (composite scene/time-scale/format/value-scale/columns)", /components\/chart\//],
  ["time series + data shaping", /src\/(time-series|utils\/price-history|market-data|data)/],
  ["react-dom reconciler", /node_modules\/(react-dom|react|scheduler)\//],
  ["DOM host (renderers/dom)", /src\/renderers\/(dom|electrobun\/view)/],
  ["plugins (builtin panes)", /src\/plugins\//],
  ["other app code", /src\//],
  ["other libraries", /node_modules\//],
];

function areaOf(frame: ProfileNode["callFrame"]): string {
  if (/^\((idle|program|garbage collector)\)$/.test(frame.functionName)) return frame.functionName;
  if (!frame.url) return "native (DOM/canvas calls)";
  const source = sourceOf(frame.url, frame.lineNumber, frame.columnNumber);
  if (!source) return "unmapped JS";
  return AREAS.find(([, pattern]) => pattern.test(source))?.[0] ?? `other: ${source}`;
}

function areaTimes(profile: Profile): Map<string, number> {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, number>();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const node = byId.get(profile.samples[index]!);
    const delta = (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0) / 1000;
    if (!node) continue;
    const area = areaOf(node.callFrame);
    totals.set(area, (totals.get(area) ?? 0) + delta);
  }
  return totals;
}

function selfTimes(profile: Profile): Map<string, number> {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, number>();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const node = byId.get(profile.samples[index]!);
    const delta = (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0) / 1000;
    if (!node) continue;
    const frame = node.callFrame;
    const file = frame.url.split("/").pop() ?? "";
    const source = frame.url ? sourceOf(frame.url, frame.lineNumber, frame.columnNumber) : null;
    const key = `${frame.functionName || "(anonymous)"} ${source ?? `${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`}`;
    totals.set(key, (totals.get(key) ?? 0) + delta);
  }
  return totals;
}

/** Time with the function anywhere on the stack, for the app's own functions (src/). */
function inclusiveTimes(profile: Profile): Map<string, number> {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const keyOf = new Map<number, string | null>();
  for (const node of profile.nodes) {
    const frame = node.callFrame;
    const source = frame.url ? sourceOf(frame.url, frame.lineNumber, frame.columnNumber) : null;
    keyOf.set(node.id, source && source.startsWith("src/") ? `${frame.functionName || "(anonymous)"} ${source}` : null);
  }
  const totals = new Map<string, number>();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const delta = (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0) / 1000;
    const seen = new Set<string>();
    for (let id: number | undefined = profile.samples[index]; id !== undefined; id = parent.get(id)) {
      const key = keyOf.get(id);
      if (key && !seen.has(key)) { seen.add(key); totals.set(key, (totals.get(key) ?? 0) + delta); }
    }
    void byId;
  }
  return totals;
}

function busyOf(totals: Map<string, number>): number {
  return [...totals.entries()].filter(([key]) => !key.startsWith("(idle)")).reduce((sum, [, ms]) => sum + ms, 0);
}

function table(title: string, totals: Map<string, number>, wallMs: number, limit = 30, busyMs?: number): string {
  const busy = busyMs ?? busyOf(totals);
  const idle = [...totals.entries()].find(([key]) => key.startsWith("(idle)"))?.[1] ?? 0;
  const lines = [`### ${title}`, "", `Wall ${wallMs.toFixed(0)} ms; main thread busy (JS, GC, native) ${busy.toFixed(0)} ms; idle ${idle.toFixed(0)} ms`, "", "| ms | % of busy | function |", "|---|---|---|"];
  for (const [key, ms] of [...totals.entries()].filter(([key]) => !key.startsWith("(idle)")).sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    lines.push(`| ${ms.toFixed(1)} | ${((ms / Math.max(busy, 1)) * 100).toFixed(1)}% | \`${key}\` |`);
  }
  return lines.join("\n");
}

async function record(cdp: Awaited<ReturnType<typeof launchBrowser>>["cdp"], name: string, run: () => Promise<void>): Promise<{ name: string; profile: Profile; wallMs: number }> {
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await cdp.send("Profiler.start");
  const started = performance.now();
  await run();
  const wallMs = performance.now() - started;
  const { profile } = await cdp.send<{ profile: Profile }>("Profiler.stop");
  await writeFile(join(outDir, `${name}.cpuprofile`), JSON.stringify(profile));
  return { name, profile, wallMs };
}

async function loadLayout(cdp: Awaited<ReturnType<typeof launchBrowser>>["cdp"], url: string, layout: object): Promise<void> {
  const config = { layouts: [{ name: "Heavy", layout }], activeLayoutIndex: 0, layout, onboardingComplete: true, telemetry: { crashReports: false, usage: false } };
  const source = `localStorage.clear(); localStorage.setItem("gloomberb.web.config.v1", ${JSON.stringify(JSON.stringify(config))});`;
  const { identifier } = await cdp.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source });
  const loaded = cdp.once("Page.loadEventFired", 60_000);
  await cdp.send("Page.navigate", { url });
  await loaded;
  await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
}

await mkdir(outDir, { recursive: true });
const replay = createReplay(replayDir, { offline });
const app = serveWebApp(dist, replay);
const browser = await launchBrowser("spike-profile", width, height);
const { cdp } = browser;
try {
  await cdp.send("Profiler.enable");
  // A first load fills the replay and the HTTP cache, so the profiled one reads from them.
  await loadLayout(cdp, app.url, heavyLayout());
  await settle(cdp, "body", 1500, 30_000);
  await sleep(2000);

  const phases = [];
  phases.push(await record(cdp, "load", async () => {
    await loadLayout(cdp, app.url, heavyLayout());
    await settle(cdp, "body", 1500, 30_000);
  }));
  const panes = await evaluate<number>(cdp, `document.querySelectorAll("[data-gloom-pane-id]").length`);
  const canvases = await evaluate<number>(cdp, `document.querySelectorAll("canvas").length`);

  const resizeRounds = async () => {
    const sizes = [[1600, 900], [1280, 800], [1920, 1080], [1440, 900], [1100, 700], [1920, 1080]];
    for (let round = 0; round < 3; round += 1) {
      for (const [w, h] of sizes) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await sleep(250);
      }
    }
    await settle(cdp, "body", 800, 10_000);
  };
  phases.push(await record(cdp, "resize", resizeRounds));

  phases.push(await record(cdp, "zoom", async () => {
    const points = await evaluate<Array<{ x: number; y: number }>>(cdp, `[...document.querySelectorAll("canvas")].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 200 && r.height > 120).slice(0, 8).map((r) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }))`);
    for (const point of points) {
      for (let step = 0; step < 12; step += 1) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: step < 6 ? -120 : 120 });
        await sleep(40);
      }
      for (let step = 0; step < 10; step += 1) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + step * 12, y: point.y, buttons: 0 });
        await sleep(16);
      }
    }
    await settle(cdp, "body", 800, 10_000);
  }));

  // The kernel in place: the same resizes with the TypeScript and the
  // WebAssembly raster, alternating, timing every panel raster in the page.
  const kernelRuns: Array<{ kernel: string; round: number; calls: number; rasterMs: number; pixels: number; fallbacks: number; busyMs: number; wallMs: number }> = [];
  for (let round = 0; round < 2; round += 1) {
    for (const kernel of round % 2 === 0 ? ["ts", "wasm"] : ["wasm", "ts"]) {
      await evaluate(cdp, `globalThis.__GLOOM_RASTER_KERNEL = ${JSON.stringify(kernel)}; globalThis.__gloomRasterStats = undefined;`);
      // A warm-up resize: loads the module and leaves every chart drawn by this kernel.
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
      await settle(cdp, "body", 600, 10_000);
      await evaluate(cdp, `globalThis.__gloomRasterStats = { kernel: "", calls: 0, ms: 0, pixels: 0, fallbacks: 0 }`);
      const phase = await record(cdp, `resize-${kernel}-${round + 1}`, resizeRounds);
      const stats = await evaluate<{ calls: number; ms: number; pixels: number; fallbacks: number }>(cdp, `globalThis.__gloomRasterStats`);
      kernelRuns.push({ kernel, round: round + 1, calls: stats.calls, rasterMs: stats.ms, pixels: stats.pixels, fallbacks: stats.fallbacks, busyMs: busyOf(selfTimes(phase.profile)), wallMs: phase.wallMs });
    }
  }
  await evaluate(cdp, `globalThis.__GLOOM_RASTER_KERNEL = "ts"; globalThis.__gloomRasterStats = undefined;`);

  // The panels a settled heavy layout draws at 1920x1080: the benchmark's inputs.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await settle(cdp, "body", 600, 10_000);
  await evaluate(cdp, `globalThis.__gloomRasterCapture = []`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await settle(cdp, "body", 800, 10_000);
  // Captured panels are frozen as JSON, and the page benchmarks the JSON, as Bun does.
  await evaluate(cdp, `globalThis.__gloomRasterFrozen = globalThis.__gloomRasterCaptureJson(); globalThis.__gloomRasterCapture = undefined; true`, 120_000);
  const captured = await evaluate<string>(cdp, `globalThis.__gloomRasterFrozen`, 120_000);
  await writeFile(join(outDir, "panels.json"), captured);
  const version = await cdp.send<{ product: string }>("Browser.getVersion").catch(() => ({ product: "chrome" }));
  const bench = await evaluate<Record<string, unknown>>(cdp, `globalThis.__gloomRasterBench({ iterations: 25, json: globalThis.__gloomRasterFrozen, runtime: ${JSON.stringify(`${version.product} (web build page)`)} })`, 600_000);
  await writeFile(join(outDir, "bench-chrome.json"), JSON.stringify(bench, null, 2));

  const all = new Map<string, number>();
  const areas = new Map<string, number>();
  const inclusive = new Map<string, number>();
  let wall = 0;
  const sections = [`# Heavy layout CPU profile (web build, headless Chrome ${width}x${height})`, "", `${panes} panes, ${canvases} canvases.`, ""];
  for (const phase of phases) {
    const totals = selfTimes(phase.profile);
    for (const [key, ms] of totals) all.set(key, (all.get(key) ?? 0) + ms);
    for (const [key, ms] of areaTimes(phase.profile)) areas.set(key, (areas.get(key) ?? 0) + ms);
    for (const [key, ms] of inclusiveTimes(phase.profile)) inclusive.set(key, (inclusive.get(key) ?? 0) + ms);
    wall += phase.wallMs;
    sections.push(table(phase.name, totals, phase.wallMs, 25), "");
  }
  sections.splice(4, 0, table("all phases, by area of the source", areas, wall, 20), "", table("all phases, by function (self time)", all, wall, 40), "", table("all phases, app functions by inclusive time", inclusive, wall, 40, busyOf(all)), "");
  const report = sections.join("\n");
  const kernelTable = ["## Raster kernel in place (same resizes, alternating)", "", "| kernel | round | panel rasters | raster ms | Mpixels | fallbacks | main thread busy ms | wall ms |", "|---|---|---|---|---|---|---|---|",
    ...kernelRuns.map((run) => `| ${run.kernel} | ${run.round} | ${run.calls} | ${run.rasterMs.toFixed(1)} | ${(run.pixels / 1e6).toFixed(1)} | ${run.fallbacks} | ${run.busyMs.toFixed(0)} | ${run.wallMs.toFixed(0)} |`),
    "", "## Raster kernel benchmark in the page", "", "```json", JSON.stringify({ ...bench, tsSamples: undefined, wasmSamples: undefined }, null, 2), "```", ""].join("\n");
  await writeFile(join(outDir, "profile.md"), `${report}\n\n${kernelTable}\n`);
  await writeFile(join(outDir, "kernel-runs.json"), JSON.stringify(kernelRuns, null, 2));
  console.log(kernelTable);
  console.log(report);
} finally {
  await browser.close();
  app.stop();
}
process.exit(0);
