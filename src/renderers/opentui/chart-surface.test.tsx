import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { ChartSurface, Text } from "../../ui";
import { getNativeSurfaceManager } from "../../components/chart/native/surface/manager";
import type { ChartRendererPreference } from "../../components/chart/core/types";
import type { CellRect } from "../../components/chart/native/chart-rasterizer";
import { AppProvider } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import { createOpenTuiTestHarness } from "./test-utils";

const tui = createOpenTuiTestHarness({ width: 40, height: 12 });

const bitmap = {
  width: 4,
  height: 4,
  pixels: new Uint8Array(4 * 4 * 4).fill(255),
};

function setNativeRendererReady(): void {
  (tui.setup().renderer as { _capabilities: unknown })._capabilities = { kitty_graphics: true };
  (tui.setup().renderer as { _resolution: unknown })._resolution = { width: 800, height: 400 };
}

function surfaces(): Map<string, { snapshot: { rect: CellRect; imageZIndex?: number } }> {
  const manager = getNativeSurfaceManager(tui.setup().renderer as never) as unknown as {
    surfaces: Map<string, { snapshot: { rect: CellRect; imageZIndex?: number } }>;
  };
  return manager.surfaces;
}

function surfaceCount(): number {
  return surfaces().size;
}

async function flushFrames(): Promise<void> {
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tui.setup().renderOnce();
  });
}

type TestCrosshair = { pixelX: number; pixelY: number; color: string } | null;
let setHarnessCrosshair: ((crosshair: TestCrosshair) => void) | null = null;

function Harness({
  preference,
  initialCrosshair = null,
}: {
  preference: ChartRendererPreference;
  initialCrosshair?: TestCrosshair;
}) {
  const config = createDefaultConfig(`/tmp/gloomberb-chart-surface-${preference}`);
  config.chartPreferences.renderer = preference;
  const [crosshair, setCrosshair] = useState<TestCrosshair>(initialCrosshair);
  setHarnessCrosshair = setCrosshair;

  return (
    <AppProvider config={config}>
      <ChartSurface width={20} height={4} flexDirection="column" bitmaps={[bitmap]} crosshair={crosshair}>
        <Text>fallback chart</Text>
      </ChartSurface>
    </AppProvider>
  );
}

describe("OpenTuiChartSurface", () => {
  test("does not register kitty surfaces when the chart renderer is forced to braille", async () => {
    const { root } = await tui.createRoot();
    setNativeRendererReady();

    act(() => {
      root.render(<Harness preference="braille" />);
    });

    await flushFrames();

    expect(tui.frame()).toContain("fallback chart");
    expect(surfaceCount()).toBe(0);
  });

  test("registers kitty surfaces when the chart renderer is forced to kitty and native graphics are ready", async () => {
    const { root } = await tui.createRoot();
    setNativeRendererReady();

    act(() => {
      root.render(<Harness preference="kitty" />);
    });

    await flushFrames();

    expect(tui.frame()).not.toContain("fallback chart");
    expect(surfaceCount()).toBe(1);
  });

  test("overlays the crosshair as thin strips above the plot and drops them with the cursor", async () => {
    const { root } = await tui.createRoot();
    setNativeRendererReady();

    // Cursor at the middle of a 4x4 source bitmap, scaled onto a 20x4 cell plot.
    act(() => {
      root.render(<Harness preference="kitty" initialCrosshair={{ pixelX: 2, pixelY: 2, color: "#ffcc00" }} />);
    });
    await flushFrames();

    const entries = surfaces();
    expect(entries.size).toBe(3);
    const vertical = [...entries].find(([id]) => id.endsWith(":crosshair-v"))![1].snapshot;
    const horizontal = [...entries].find(([id]) => id.endsWith(":crosshair-h"))![1].snapshot;
    // Both strips stay inside the plot and cover only the cursor's cells.
    expect(vertical.rect).toEqual({ x: 12, y: 0, width: 3, height: 4 });
    expect(horizontal.rect).toEqual({ x: 0, y: 2, width: 20, height: 1 });
    expect(vertical.imageZIndex).toBe(1);
    expect(horizontal.imageZIndex).toBe(1);

    act(() => {
      setHarnessCrosshair!(null);
    });
    await flushFrames();

    expect(surfaceCount()).toBe(1);
  });
});
