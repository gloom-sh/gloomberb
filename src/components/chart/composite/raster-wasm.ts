/**
 * Prototype: the composite chart's raster kernel in WebAssembly
 * (kernels/chart-raster). TypeScript still lays the panel out and records its
 * drawing calls; the module replays them into pixels. The same bytes load in
 * the browser, the desktop window, Bun and the terminal app.
 *
 * Off unless asked for: `GLOOM_RASTER_KERNEL=wasm` in the environment, or
 * `localStorage["gloom.rasterKernel"] = "wasm"` in a page.
 */
import type { NativeChartBitmap } from "../native/chart-rasterizer";
import { renderCompositePanelBitmap } from "./rasterizer";
import { RASTER_KERNEL_BASE64 } from "./raster-kernel.generated";
import type { CompositeChartColors, CompositePanelScene } from "./types";

interface KernelExports {
  memory: WebAssembly.Memory;
  ops_buffer(count: number): number;
  render(width: number, height: number, count: number): number;
}

let kernel: KernelExports | null = null;
let loading: Promise<KernelExports | null> | null = null;

function moduleBytes(): Uint8Array {
  if (typeof atob === "function") {
    const text = atob(RASTER_KERNEL_BASE64);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
    return bytes;
  }
  return new Uint8Array(Buffer.from(RASTER_KERNEL_BASE64, "base64"));
}

/** Compiles the module; synchronously where the runtime allows a module this size, else in the background. */
export function loadRasterKernel(): Promise<KernelExports | null> {
  if (kernel) return Promise.resolve(kernel);
  if (loading) return loading;
  const bytes = moduleBytes();
  try {
    kernel = new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource), {}).exports as unknown as KernelExports;
    return Promise.resolve(kernel);
  } catch {
    // Chromium refuses large synchronous compiles on the main thread.
  }
  loading = WebAssembly.instantiate(bytes as BufferSource, {})
    .then(({ instance }) => (kernel = instance.exports as unknown as KernelExports))
    .catch(() => null);
  return loading;
}

export function rasterKernelReady(): boolean {
  if (!kernel && !loading) void loadRasterKernel();
  return kernel !== null;
}

export function rasterKernelRequested(): boolean {
  const fromGlobal = (globalThis as { __GLOOM_RASTER_KERNEL?: string }).__GLOOM_RASTER_KERNEL;
  if (fromGlobal) return fromGlobal === "wasm";
  try {
    if (typeof process !== "undefined" && process.env?.GLOOM_RASTER_KERNEL) return process.env.GLOOM_RASTER_KERNEL === "wasm";
  } catch {}
  try {
    return globalThis.localStorage?.getItem("gloom.rasterKernel") === "wasm";
  } catch {
    return false;
  }
}

/** The op list a panel draws, as `renderCompositePanelBitmap` would draw it. */
export function recordCompositePanelOps(
  panel: CompositePanelScene,
  options: { pixelWidth: number; pixelHeight: number; colors: CompositeChartColors; snapGridToRows?: boolean },
): { width: number; height: number; ops: number[] } {
  const ops: number[] = [];
  const { width, height } = renderCompositePanelBitmap(panel, { ...options, recordOps: ops });
  return { width, height, ops };
}

/** Replays an op list in the module; null when the module is not loaded or rejects the list. */
export function replayRasterOps(width: number, height: number, ops: readonly number[] | Float64Array): Uint8Array | null {
  if (!rasterKernelReady() || !kernel) return null;
  const at = kernel.ops_buffer(ops.length);
  new Float64Array(kernel.memory.buffer, at, ops.length).set(ops);
  const pixels = kernel.render(width, height, ops.length);
  if (pixels === 0) return null;
  return new Uint8Array(kernel.memory.buffer, pixels, width * height * 4).slice();
}

/** `renderCompositePanelBitmap` with the pixel work in WebAssembly; null when the module is not ready. */
export function renderCompositePanelBitmapWasm(
  panel: CompositePanelScene,
  options: { pixelWidth: number; pixelHeight: number; colors: CompositeChartColors; snapGridToRows?: boolean },
): NativeChartBitmap | null {
  if (!rasterKernelReady()) return null;
  const { width, height, ops } = recordCompositePanelOps(panel, options);
  const pixels = replayRasterOps(width, height, ops);
  return pixels ? { width, height, pixels } : null;
}
