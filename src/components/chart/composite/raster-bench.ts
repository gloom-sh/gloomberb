/**
 * Prototype: the raster kernel benchmark, TypeScript against WebAssembly on
 * the same panels. It lives in the app's own bundle so it runs where the app
 * runs: a page (`globalThis.__gloomRasterBench`), the desktop window, Bun.
 */
import { renderCompositePanelBitmap } from "./rasterizer";
import { loadRasterKernel, recordCompositePanelOps, replayRasterOps } from "./raster-wasm";
import type { CompositeChartColors, CompositePanelScene } from "./types";

export interface RasterBenchInput {
  panel: CompositePanelScene;
  options: { pixelWidth: number; pixelHeight: number; colors: CompositeChartColors; snapGridToRows?: boolean };
}

export interface RasterBenchResult {
  runtime: string;
  panels: number;
  pixels: number;
  ops: number;
  iterations: number;
  repeat: number;
  /** Panels whose WebAssembly pixels differ from the TypeScript ones, and by how many bytes. */
  mismatchedPanels: number;
  mismatchedBytes: number;
  /** Median over iterations of one pass over every panel, in ms. */
  tsMs: number;
  wasmMs: number;
  recordMs: number;
  replayMs: number;
  speedup: number;
  tsSamples: number[];
  wasmSamples: number[];
}

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** The last raster of each panel at each size: what a settled layout drew. */
export function distinctRasterInputs(inputs: RasterBenchInput[]): RasterBenchInput[] {
  const byKey = new Map<string, RasterBenchInput>();
  for (const input of inputs) {
    const key = `${input.panel.id}|${input.panel.series.map((series) => series.source.id).join(",")}|${Math.floor(input.options.pixelWidth)}x${Math.floor(input.options.pixelHeight)}`;
    byKey.delete(key);
    byKey.set(key, input);
  }
  return [...byKey.values()];
}

/**
 * Each sample times `repeat` passes over every panel (so a coarse clock, as
 * WebKit's 1 ms one, still resolves it) and reports one pass.
 */
export async function runRasterBench(inputs: RasterBenchInput[], { iterations = 15, warmup = 3, repeat = 4, runtime = "unknown" } = {}): Promise<RasterBenchResult> {
  if (!await loadRasterKernel()) throw new Error("The WebAssembly kernel did not load");
  const now = () => performance.now();
  let pixels = 0;
  let ops = 0;
  let mismatchedPanels = 0;
  let mismatchedBytes = 0;
  for (const input of inputs) {
    const reference = renderCompositePanelBitmap(input.panel, input.options);
    const recorded = recordCompositePanelOps(input.panel, input.options);
    const replayed = replayRasterOps(recorded.width, recorded.height, recorded.ops);
    pixels += reference.width * reference.height;
    ops += recorded.ops.length;
    if (!replayed || replayed.length !== reference.pixels.length) {
      mismatchedPanels += 1;
      mismatchedBytes += reference.pixels.length;
      continue;
    }
    let differing = 0;
    for (let index = 0; index < replayed.length; index += 1) if (replayed[index] !== reference.pixels[index]) differing += 1;
    if (differing) {
      mismatchedPanels += 1;
      mismatchedBytes += differing;
    }
  }

  const tsSamples: number[] = [];
  const wasmSamples: number[] = [];
  const recordSamples: number[] = [];
  const replaySamples: number[] = [];
  const recordings = inputs.map((input) => recordCompositePanelOps(input.panel, input.options));
  for (let round = 0; round < warmup + iterations; round += 1) {
    // Alternate which kernel goes first, so neither always runs on a warmer cache.
    const order = round % 2 === 0 ? ["ts", "wasm"] : ["wasm", "ts"];
    for (const kernel of order) {
      const started = now();
      for (let pass = 0; pass < repeat; pass += 1) {
        for (const input of inputs) {
          if (kernel === "ts") renderCompositePanelBitmap(input.panel, input.options);
          else {
            const recorded = recordCompositePanelOps(input.panel, input.options);
            replayRasterOps(recorded.width, recorded.height, recorded.ops);
          }
        }
      }
      if (round >= warmup) (kernel === "ts" ? tsSamples : wasmSamples).push((now() - started) / repeat);
    }
    let started = now();
    for (let pass = 0; pass < repeat; pass += 1) for (const input of inputs) recordCompositePanelOps(input.panel, input.options);
    if (round >= warmup) recordSamples.push((now() - started) / repeat);
    started = now();
    for (let pass = 0; pass < repeat; pass += 1) for (const recorded of recordings) replayRasterOps(recorded.width, recorded.height, recorded.ops);
    if (round >= warmup) replaySamples.push((now() - started) / repeat);
  }
  const tsMs = median(tsSamples);
  const wasmMs = median(wasmSamples);
  return {
    runtime,
    panels: inputs.length,
    pixels,
    ops,
    iterations,
    repeat,
    mismatchedPanels,
    mismatchedBytes,
    tsMs,
    wasmMs,
    recordMs: median(recordSamples),
    replayMs: median(replaySamples),
    speedup: tsMs / wasmMs,
    tsSamples,
    wasmSamples,
  };
}

/** For the measurement harnesses: the bench over the panels this page drew, kept by `__gloomRasterCapture`. */
(globalThis as { __gloomRasterBench?: unknown }).__gloomRasterBench = async (options: { iterations?: number; repeat?: number; runtime?: string; json?: string } = {}) => {
  const captured = (globalThis as { __gloomRasterCapture?: RasterBenchInput[] }).__gloomRasterCapture ?? [];
  const inputs = options.json ? reviveRasterInputs(options.json) : distinctRasterInputs(captured);
  return runRasterBench(inputs, options);
};

/** The distinct captured panels as JSON that keeps dates, maps and non-finite numbers. */
export function serializeRasterInputs(inputs: RasterBenchInput[]): string {
  return JSON.stringify(inputs, function replacer(this: Record<string, unknown>, key: string, value: unknown) {
    const raw = this[key];
    if (raw instanceof Date) return { $date: raw.getTime() };
    if (raw instanceof Map) return { $map: [...raw.entries()] };
    if (raw instanceof Set) return { $set: [...raw] };
    if (typeof raw === "number" && !Number.isFinite(raw)) return { $num: String(raw) };
    return value;
  });
}

export function reviveRasterInputs(json: string): RasterBenchInput[] {
  return JSON.parse(json, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$date" in value) return new Date(value.$date);
      if ("$map" in value) return new Map(value.$map);
      if ("$set" in value) return new Set(value.$set);
      if ("$num" in value) return Number(value.$num);
    }
    return value;
  });
}

(globalThis as { __gloomRasterCaptureJson?: unknown }).__gloomRasterCaptureJson = () => (
  serializeRasterInputs(distinctRasterInputs((globalThis as { __gloomRasterCapture?: RasterBenchInput[] }).__gloomRasterCapture ?? []))
);
