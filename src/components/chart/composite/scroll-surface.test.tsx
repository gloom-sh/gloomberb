import { afterEach, describe, expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act, useEffect, useReducer, useRef } from "react";
import { createOpenTuiTestRoot as createRoot } from "../../../renderers/opentui/test-utils";
import {
  AppContext,
  PaneInstanceProvider,
  appReducer,
  createInitialState,
} from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { createDefaultConfig } from "../../../types/config";
import { getNativeSurfaceManager } from "../native/surface/manager";
import { CompositeChart, pricePointsToResolvedSeries } from "./index";

/**
 * A kitty chart draws into a native surface positioned over the terminal grid,
 * so it has to be created and destroyed as the chart scrolls in and out of its
 * ScrollBox. A surface left behind paints over whatever is now in that row.
 */
const TEST_PANE_ID = "composite-scroll:test";

let testSetup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
let root: ReturnType<typeof createRoot> | undefined;
let scrollBoxRef: ScrollBoxRenderable | null = null;
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const PRICE_SERIES = pricePointsToResolvedSeries(
  [
    { date: new Date("2026-04-01T00:00:00Z"), close: 0.45 },
    { date: new Date("2026-04-02T00:00:00Z"), close: 0.48 },
    { date: new Date("2026-04-03T00:00:00Z"), close: 0.51 },
    { date: new Date("2026-04-04T00:00:00Z"), close: 0.49 },
  ],
  { id: "scroll-price", label: "Price", color: colors.positive, unit: "USD", style: "area", panelId: "price" },
);

function ChartScrollHarness() {
  const [state, dispatch] = useReducer(
    appReducer,
    (() => {
      const config = createDefaultConfig("/tmp/gloomberb-test");
      config.chartPreferences.renderer = "kitty";
      const initial = createInitialState(config);
      initial.focusedPaneId = TEST_PANE_ID;
      return initial;
    })(),
  );
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    scrollBoxRef = scrollRef.current;
  });

  return (
    <AppContext value={{ state, dispatch }}>
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <scrollbox ref={scrollRef} height={10} scrollY>
          <box flexDirection="column">
            <box height={14}>
              <text>filler</text>
            </box>
            <CompositeChart
              width={60}
              height={11}
              focused
              interactive
              series={[PRICE_SERIES]}
              panels={[{ id: "price" }]}
              axisWidth={8}
              showLegend={false}
            />
          </box>
        </scrollbox>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function flushFrames(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await testSetup!.renderOnce();
    });
  }
}

afterEach(() => {
  scrollBoxRef = null;
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = undefined;
  }
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("CompositeChart kitty scrolling", () => {
  test("creates a native chart surface when scrolled into view", async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    testSetup = await createTestRenderer({ width: 100, height: 24 });
    (testSetup.renderer as unknown as { _capabilities: unknown })._capabilities = {
      kitty_graphics: true,
    };
    (testSetup.renderer as unknown as { _resolution: unknown })._resolution = {
      width: 1000,
      height: 720,
    };

    root = createRoot(testSetup.renderer);
    act(() => {
      root!.render(<ChartScrollHarness />);
    });

    await flushFrames();

    const manager = getNativeSurfaceManager(testSetup.renderer as never) as unknown as {
      surfaces: Map<
        string,
        {
          snapshot: {
            paneId: string;
            visibleRect: { x: number; y: number; width: number; height: number } | null;
          };
        }
      >;
    };

    const findChartSurface = () => [...manager.surfaces.values()]
      .find((surface) => surface.snapshot.paneId === TEST_PANE_ID);
    expect(findChartSurface()).toBeUndefined();

    act(() => {
      scrollBoxRef!.scrollTop = 14;
    });

    await flushFrames();

    const visibleSurface = findChartSurface();
    expect(visibleSurface).toBeDefined();
    expect(visibleSurface?.snapshot.visibleRect).not.toBeNull();
  });
});
