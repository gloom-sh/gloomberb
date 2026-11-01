/**
 * Prototype check: the terminal app's kitty chart draws through the
 * WebAssembly raster kernel, and its pixels match the TypeScript raster.
 *
 *   timeout -k 10 120 bun test scripts/spike/terminal-kernel.test.tsx
 */
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../src/renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../src/state/app/context";
import { createStaticAppStore } from "../../src/test-support/app-store";
import { colors } from "../../src/theme/colors";
import { createDefaultConfig } from "../../src/types/config";
import { CompositeChart, pricePointsToResolvedSeries } from "../../src/components/chart/composite/index";
import { loadRasterKernel } from "../../src/components/chart/composite/raster-wasm";
import { distinctRasterInputs, runRasterBench, type RasterBenchInput } from "../../src/components/chart/composite/raster-bench";

const PANE_ID = "terminal-kernel:test";
const tui = createOpenTuiTestHarness({ width: 120, height: 32 });

/** Five years of daily candles from a seeded walk. */
function candles() {
  let seed = 7;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  let close = 100;
  const points = [];
  for (let day = 0; day < 1260; day += 1) {
    const open = close;
    close = Math.max(1, open * (1 + (random() - 0.5) * 0.04));
    const high = Math.max(open, close) * (1 + random() * 0.01);
    const low = Math.min(open, close) * (1 - random() * 0.01);
    points.push({ date: new Date(Date.UTC(2021, 0, 4) + day * 86_400_000), open, high, low, close, volume: Math.round(1e6 + random() * 1e6) });
  }
  return points;
}

const SERIES = pricePointsToResolvedSeries(candles(), { id: "kernel-candles", label: "Price", color: colors.positive, unit: "USD", style: "candles", panelId: "price" });

function Chart() {
  const config = createDefaultConfig("/tmp/gloomberb-test");
  config.chartPreferences.renderer = "kitty";
  const state = createInitialState(config);
  state.focusedPaneId = PANE_ID;
  return (
    <AppContext value={createStaticAppStore(state, () => {})}>
      <PaneInstanceProvider paneId={PANE_ID}>
        <CompositeChart width={110} height={28} focused interactive series={[SERIES]} panels={[{ id: "price" }]} axisWidth={8} showLegend={false} />
      </PaneInstanceProvider>
    </AppContext>
  );
}

type Hooks = { __GLOOM_RASTER_KERNEL?: string; __gloomRasterStats?: { kernel: string; calls: number; ms: number; pixels: number; fallbacks: number }; __gloomRasterCapture?: RasterBenchInput[] };
const hooks = globalThis as Hooks;

afterAll(() => {
  delete hooks.__GLOOM_RASTER_KERNEL;
  delete hooks.__gloomRasterStats;
  delete hooks.__gloomRasterCapture;
});

test("the kitty chart rasters through the WebAssembly kernel, byte for byte", async () => {
  expect(await loadRasterKernel()).not.toBeNull();
  hooks.__GLOOM_RASTER_KERNEL = "wasm";
  hooks.__gloomRasterStats = { kernel: "", calls: 0, ms: 0, pixels: 0, fallbacks: 0 };
  hooks.__gloomRasterCapture = [];
  const { setup, root } = await tui.createRoot();
  (setup.renderer as unknown as { _capabilities: unknown })._capabilities = { kitty_graphics: true };
  (setup.renderer as unknown as { _resolution: unknown })._resolution = { width: 1200, height: 900 };
  act(() => root.render(<Chart />));
  for (let frame = 0; frame < 12; frame += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.renderOnce();
    });
  }
  const stats = hooks.__gloomRasterStats!;
  console.log(`terminal: ${stats.calls} rasters by ${stats.kernel}, ${(stats.pixels / 1e6).toFixed(2)} Mpixels, ${stats.ms.toFixed(1)} ms, ${stats.fallbacks} fallbacks`);
  expect(stats.calls).toBeGreaterThan(0);
  expect(stats.kernel).toBe("wasm");
  expect(stats.fallbacks).toBe(0);
  const bench = await runRasterBench(distinctRasterInputs(hooks.__gloomRasterCapture!), { iterations: 3, warmup: 1, repeat: 1, runtime: "terminal (OpenTUI, kitty)" });
  console.log(`terminal panels: ${bench.panels}, mismatched ${bench.mismatchedPanels}, TS ${bench.tsMs.toFixed(2)} ms, WASM ${bench.wasmMs.toFixed(2)} ms`);
  expect(bench.panels).toBeGreaterThan(0);
  expect(bench.mismatchedPanels).toBe(0);
});
