import { expect, test } from "bun:test";
import { act } from "react";
import { getNativeSurfaceManager } from "../chart/native/surface/manager";
import type { NativeChartBitmap } from "../chart/native/chart-rasterizer";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppProvider } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import type { PricePoint } from "../../types/financials";
import { Box } from "../../ui";
import { PriceSparkline } from "./view";

const tui = createOpenTuiTestHarness({ width: 40, height: 12 });

const history: PricePoint[] = Array.from({ length: 20 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 0, 1 + index)),
  close: 100 + Math.sin(index / 3) * 5,
}));

function renderer() {
  return tui.setup().renderer as unknown as {
    _capabilities: unknown;
    _resolution: { width: number; height: number } | null;
    emit(event: string, ...args: unknown[]): boolean;
  };
}

function plotWidth(): number | undefined {
  const manager = getNativeSurfaceManager(tui.setup().renderer as never) as unknown as {
    surfaces: Map<string, { snapshot: { bitmap: NativeChartBitmap } }>;
  };
  return [...manager.surfaces.values()][0]?.snapshot.bitmap.width;
}

async function flushFrames(): Promise<void> {
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tui.setup().renderOnce();
  });
}

test("a sparkline nothing re-renders redraws its bitmap at the new pixel size after a late resolution reply or a font zoom", async () => {
  const { root } = await tui.createRoot();
  renderer()._capabilities = { kitty_graphics: true };
  renderer()._resolution = { width: 800, height: 400 };
  const config = createDefaultConfig("/tmp/gloomberb-price-sparkline-view");
  config.chartPreferences.renderer = "kitty";
  // Rendered once: no parent render follows, as for a watchlist row whose quote did not change.
  act(() => {
    root.render(
      <AppProvider config={config}>
        <Box width={10} height={1}><PriceSparkline priceHistory={history} width={10} /></Box>
      </AppProvider>,
    );
  });
  await flushFrames();
  // 10 cells of 800px / 40 columns.
  expect(plotWidth()).toBe(200);

  // The terminal answers with its real pixel size after the first frames.
  renderer()._resolution = { width: 1600, height: 800 };
  await act(async () => { renderer().emit("resolution", renderer()._resolution); });
  await flushFrames();
  expect(plotWidth()).toBe(400);

  // A font zoom out: twice the columns in the same window, so half the pixels per cell.
  await act(async () => { tui.setup().resize(80, 24); });
  await flushFrames();
  expect(plotWidth()).toBe(200);
});
