import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  createElement,
  forwardRef,
  useMemo,
  useState,
  type ForwardedRef,
  type ReactNode,
} from "react";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import { testRender } from "../../../renderers/opentui/test-utils";
import {
  Box,
  Text,
  UiHostProvider,
  useNativeRenderer,
  useRendererHost,
  useUiHost,
  type BoxRenderable,
} from "../../../ui";
import {
  InputHostProvider,
  type InputHost,
  type KeyEventLike,
} from "../../../react/input";
import { CompositeChart } from "./composite-chart";
import { createDefaultConfig } from "../../../types/config";
import { AppContext, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import {
  resolveCompositeMinimumSpanMs,
  zoomCompositeViewport,
} from "./interactions";
import { getThemeColors, syncTheme } from "../../../theme/colors";
import { ThemeProvider } from "../../../theme/theme-context";
import { DEFAULT_THEME } from "../../../theme/themes";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let chartShortcut: ((event: KeyEventLike) => void) | null = null;
let capturedSurfaceProps: Record<string, any> | null = null;
let capturedSurfaceNode: BoxRenderable | null = null;

const chartInputHost: InputHost = {
  useShortcut(handler) {
    chartShortcut = handler;
  },
  useViewport() {
    return { width: 80, height: 24 };
  },
};

function assignRef(ref: ForwardedRef<any>, value: any) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function CaptureChartSurfaceProvider({
  children,
  canvasCharts = false,
}: {
  children: ReactNode;
  canvasCharts?: boolean;
}) {
  const baseUi = useUiHost();
  const renderer = useRendererHost();
  const nativeRenderer = useNativeRenderer();
  const CapturingChartSurface = useMemo(() => {
    const BaseChartSurface = baseUi.ChartSurface;
    return forwardRef<any, Record<string, any>>(function CapturingSurface(props, ref) {
      capturedSurfaceProps = props;
      return createElement(BaseChartSurface as any, {
        ...props,
        ref: (node: BoxRenderable | null) => {
          capturedSurfaceNode = node;
          assignRef(ref, node);
        },
      });
    });
  }, [baseUi]);
  const ui = useMemo(
    () => ({
      ...baseUi,
      ChartSurface: CapturingChartSurface,
      capabilities: canvasCharts
        ? { ...baseUi.capabilities, canvasCharts: true, nativeCharts: false }
        : baseUi.capabilities,
    }),
    [CapturingChartSurface, baseUi, canvasCharts],
  );
  return (
    <UiHostProvider ui={ui} renderer={renderer} nativeRenderer={nativeRenderer}>
      {children}
    </UiHostProvider>
  );
}

function pointerEvent(
  localX: number,
  localY: number,
  options: {
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    scroll?: { direction: "up" | "down" | "left" | "right"; delta: number };
  } = {},
) {
  const node = capturedSurfaceNode!;
  return {
    x: (node.x as number) + localX,
    y: (node.y as number) + localY,
    modifiers: {
      shift: options.shift === true,
      alt: options.alt === true,
      ctrl: options.ctrl === true,
    },
    scroll: options.scroll,
    preventDefault() {},
    stopPropagation() {},
  };
}

function keyEvent(name: string, shift = false): KeyEventLike {
  let defaultPrevented = false;
  let propagationStopped = false;
  return {
    key: name,
    name,
    sequence: name,
    ctrl: false,
    shift,
    alt: false,
    meta: false,
    get defaultPrevented() {
      return defaultPrevented;
    },
    get propagationStopped() {
      return propagationStopped;
    },
    preventDefault() {
      defaultPrevented = true;
    },
    stopPropagation() {
      propagationStopped = true;
    },
  };
}

afterEach(async () => {
  if (testSetup) await act(async () => testSetup!.renderer.destroy());
  testSetup = undefined;
  chartShortcut = null;
  capturedSurfaceProps = null;
  capturedSurfaceNode = null;
  syncTheme(DEFAULT_THEME);
});

function point(date: string, value: number): TimeSeriesPoint {
  const observedAt = new Date(`${date}T00:00:00.000Z`);
  return { date: observedAt, observedAt, value };
}

function timestampPoint(timestamp: string, value: number): TimeSeriesPoint {
  const observedAt = new Date(timestamp);
  return { date: observedAt, observedAt, value };
}

function series(id: string, panelId: string, axis: ResolvedSeries["axis"], unit: string, values: number[]): ResolvedSeries {
  return {
    id,
    label: id === "price" ? "ACME Price" : "OTHER Revenue",
    color: id === "price" ? "#00ff66" : "#ffaa00",
    unit,
    unitGroup: unit === "USD" ? "currency" : "percent",
    nativeFrequency: id === "price" ? "daily" : "quarterly",
    dataShape: "scalar",
    style: id === "price" ? "line" : "step",
    transform: "raw",
    axis,
    panelId,
    interpolation: id === "price" ? "none" : "step-after",
    points: values.map((value, index) => point(`2025-01-0${index + 1}`, value)),
  };
}

function twoSessionCandles(): ResolvedSeries {
  const points = [
    ...Array.from({ length: 7 }, (_, index) => (
      Date.UTC(2025, 0, 2, 17, index * 30)
    )),
    ...Array.from({ length: 8 }, (_, index) => (
      Date.UTC(2025, 0, 3, 13, 30 + index * 30)
    )),
  ].map((timestamp, index) => {
    const date = new Date(timestamp);
    const value = 100 + index * 0.1;
    return {
      date,
      observedAt: date,
      value,
      open: value,
      high: value + 1,
      low: value - 1,
      close: value,
      volume: 100,
    };
  });
  return {
    ...series("price", "main", "left", "USD", []),
    nativeFrequency: "intraday",
    dataShape: "ohlc",
    style: "candles",
    timeBasis: {
      kind: "market",
      timeZone: "America/New_York",
      cadenceMs: 30 * 60_000,
    },
    points,
  };
}

describe("CompositeChart", () => {
  test("repaints cached chart rasters when the theme changes", async () => {
    let setThemeId: ((themeId: string) => void) | null = null;
    const chartSeries = [series("price", "main", "left", "USD", [100, 101, 102])];

    function ThemedChart() {
      const [themeId, setTheme] = useState(DEFAULT_THEME);
      setThemeId = setTheme;
      return (
        <ThemeProvider themeId={themeId}>
          <CaptureChartSurfaceProvider>
            <CompositeChart
              width={60}
              height={12}
              series={chartSeries}
              panels={[{ id: "main" }]}
            />
          </CaptureChartSurfaceProvider>
        </ThemeProvider>
      );
    }

    testSetup = await testRender(<ThemedChart />, { width: 62, height: 14 });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const nextThemeId = "github-light";
    await act(async () => {
      setThemeId?.(nextThemeId);
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const bitmap = capturedSurfaceProps!.bitmaps[0] as { pixels: Uint8Array };
    const expectedBackground = getThemeColors(nextThemeId).bg;
    const expectedRgb = [1, 3, 5].map((offset) => parseInt(expectedBackground.slice(offset, offset + 2), 16));
    expect(Array.from(bitmap.pixels.slice(0, 3))).toEqual(expectedRgb);
  });

  test("does not allocate a native raster when braille rendering is forced", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-composite-braille");
    config.chartPreferences.renderer = "braille";

    testSetup = await testRender(
      <AppContext value={{ state: createInitialState(config), dispatch: () => {} }}>
        <CaptureChartSurfaceProvider>
          <CompositeChart
            width={60}
            height={12}
            series={[series("price", "main", "left", "USD", [100, 101, 102])]}
            panels={[{ id: "main" }]}
          />
        </CaptureChartSurfaceProvider>
      </AppContext>,
      { width: 62, height: 14 },
    );
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(capturedSurfaceProps!.bitmaps).toBeNull();
  });

  test("shows the regular-session move beside the latest intraday value", async () => {
    testSetup = await testRender(
      <CompositeChart
        width={60}
        height={12}
        series={[{
          ...series("price", "main", "left", "USD", [100, 110]),
          latestChangePercent: 10.65,
        }]}
        panels={[{ id: "main" }]}
        showLatestChangePercent
      />,
      { width: 62, height: 14 },
    );

    await act(async () => testSetup!.renderOnce());

    expect(testSetup.captureCharFrame()).toContain("ACME Price $110 +10.65%");
  });

  test("lays out mixed panels with one shared legend and time axis", async () => {
    testSetup = await testRender(
      <CompositeChart
        width={78}
        height={18}
        series={[
          series("price", "main", "left", "USD", [100, 103, 101]),
          series("revenue", "fundamentals", "right", "%", [4, 6, 8]),
        ]}
        panels={[{ id: "main", height: 2 }, { id: "fundamentals", height: 1 }]}
        cursorDate={new Date("2025-01-02T00:00:00.000Z")}
      />,
      { width: 80, height: 20 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("2025-01-02");
    expect(frame).toContain("ACME Price");
    expect(frame).toContain("OTHER Revenue");
    expect(frame).toContain("$103");
    expect(frame.match(/Jan 1/g)).toHaveLength(1);
    expect(frame.match(/Jan 3/g)).toHaveLength(1);
  });

  test("keeps legend items compact and anchors an accessory to the right edge", async () => {
    testSetup = await testRender(
      <CompositeChart
        width={78}
        height={12}
        series={[
          series("price", "main", "left", "USD", [100, 103, 101]),
          series("revenue", "main", "right", "%", [4, 6, 8]),
        ]}
        panels={[{ id: "main" }]}
        cursorDate={new Date("2025-01-02T00:00:00.000Z")}
        legendAccessory={(
          <Box width={14} height={1} overflow="hidden">
            <Text>+ add series</Text>
          </Box>
        )}
      />,
      { width: 80, height: 14 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const legend = testSetup.captureCharFrame()
      .split("\n")
      .find((line) => line.includes("+ add series"));
    expect(legend).toBeDefined();
    expect(legend).toContain("ACME Price $103");
    expect(legend).toContain("OTHER Revenue 6.00%");
    const accessoryStart = legend!.indexOf("+ add series");
    const lastLegendEnd = legend!.indexOf("6.00%") + "6.00%".length;
    expect(accessoryStart).toBe(78 - 14);
    expect(accessoryStart - lastLegendEnd).toBeGreaterThan(1);
  });

  test("keeps non-plotted legend series available for restoring", async () => {
    const price = series("price", "main", "left", "USD", [100, 103, 101]);
    const hiddenRevenue = series("revenue", "main", "right", "%", [4, 6, 8]);
    testSetup = await testRender(
      <CompositeChart
        width={78}
        height={12}
        series={[price]}
        legendSeries={[price, hiddenRevenue]}
        panels={[{ id: "main" }]}
        cursorDate={new Date("2025-01-02T00:00:00.000Z")}
      />,
      { width: 80, height: 14 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(testSetup.captureCharFrame()).toContain("OTHER Revenue");
  });

  test("uses buffered market anchors so closed sessions do not create chart holes", async () => {
    const candles = twoSessionCandles();
    const currentSession = {
      ...candles,
      points: candles.points.filter((point) => point.date.getUTCDate() === 3),
    };
    testSetup = await testRender(
      <CompositeChart
        width={72}
        height={12}
        series={[candles]}
        legendSeries={[currentSession]}
        panels={[{ id: "main" }]}
        viewport={{
          start: new Date("2025-01-02T17:00:00.000Z"),
          end: new Date("2025-01-03T17:00:00.000Z"),
        }}
        showLegend={false}
      />,
      { width: 74, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());

    const bodyColumns = [...new Set(testSetup.captureCharFrame()
      .split("\n")
      .flatMap((line) => [...line].flatMap((cell, index) => cell === "█" ? [index] : [])))]
      .sort((left, right) => left - right);
    const largestGap = bodyColumns.slice(1).reduce(
      (largest, column, index) => Math.max(largest, column - bodyColumns[index]!),
      0,
    );

    expect(bodyColumns.length).toBeGreaterThan(10);
    expect(largestGap).toBeLessThan(10);
  });

  test("toggles a series from its legend entry", async () => {
    const toggled: string[] = [];
    testSetup = await testRender(
      <CompositeChart
        width={58}
        height={10}
        series={[
          series("price", "main", "left", "USD", [100, 103, 101]),
          series("revenue", "main", "right", "%", [4, 6, 8]),
        ]}
        panels={[{ id: "main" }]}
        onToggleSeries={(seriesId) => toggled.push(seriesId)}
      />,
      { width: 60, height: 12 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });
    const priceColumn = testSetup.captureCharFrame().split("\n")[0]!.indexOf("ACME Price");
    expect(priceColumn).toBeGreaterThan(0);

    await act(async () => {
      await testSetup!.mockMouse.click(priceColumn, 0);
      await testSetup!.renderOnce();
    });
    expect(toggled).toEqual(["price"]);
  });

  test("scrolls an overflowing legend horizontally", async () => {
    const labels = ["FIRST LONG SERIES", "SECOND LONG SERIES", "THIRD LONG SERIES", "LAST LONG SERIES"];
    const overflowingSeries = labels.map((label, index) => ({
      ...series(`series-${index}`, "main", "left", "USD", [index + 1, index + 2]),
      label,
    }));
    testSetup = await testRender(
      <CompositeChart
        width={38}
        height={10}
        series={overflowingSeries}
        panels={[{ id: "main" }]}
      />,
      { width: 40, height: 12 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame().split("\n")[0]).toContain("FIRST LONG SERIES");
    expect(testSetup.captureCharFrame().split("\n")[0]).not.toContain("LAST LONG SERIES");

    await act(async () => {
      for (let index = 0; index < 120; index += 1) {
        await testSetup!.mockMouse.scroll(20, 0, "down");
      }
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame().split("\n")[0]).toContain("LAST LONG SERIES");
  });

  test("reaches and toggles overflowing legend series from the keyboard", async () => {
    const toggled: string[] = [];
    const labels = ["FIRST LONG SERIES", "SECOND LONG SERIES", "THIRD LONG SERIES", "LAST LONG SERIES"];
    const overflowingSeries = labels.map((label, index) => ({
      ...series(`series-${index}`, "main", "left", "USD", [index + 1, index + 2]),
      label,
    }));
    testSetup = await testRender(
      <InputHostProvider host={chartInputHost}>
        <CompositeChart
          width={38}
          height={10}
          focused
          series={overflowingSeries}
          panels={[{ id: "main" }]}
          onToggleSeries={(seriesId) => toggled.push(seriesId)}
        />
      </InputHostProvider>,
      { width: 40, height: 12 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      for (let index = 0; index < overflowingSeries.length; index += 1) {
        chartShortcut?.(keyEvent("]"));
      }
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame().split("\n")[0]).toContain("LAST LONG SERIES");

    await act(async () => {
      chartShortcut?.(keyEvent("space"));
      await testSetup!.renderOnce();
    });
    expect(toggled).toEqual(["series-3"]);
  });

  test("keeps the legend accessory visible when the pane is narrower than its legend", async () => {
    testSetup = await testRender(
      <CompositeChart
        width={20}
        height={10}
        series={[series("price", "main", "left", "USD", [100, 103, 101])]}
        panels={[{ id: "main" }]}
        legendAccessory={(
          <Box width={14} height={1} overflow="hidden">
            <Text>+ add series</Text>
          </Box>
        )}
        legendAccessoryWidth={14}
      />,
      { width: 22, height: 12 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const legend = testSetup.captureCharFrame()
      .split("\n")
      .find((line) => line.includes("+ add series"));
    expect(legend).toBeDefined();
    expect(legend).toContain("●");
  });

  test("moves and clears the shared cursor from the keyboard while focused", async () => {
    const cursorChanges: Array<string | null> = [];
    testSetup = await testRender(
      <InputHostProvider host={chartInputHost}>
        <CompositeChart
          width={60}
          height={12}
          focused
          series={[series("price", "main", "left", "USD", [100, 103, 101])]}
          panels={[{ id: "main" }]}
          onCursorDateChange={(date) => cursorChanges.push(date?.toISOString() ?? null)}
        />
      </InputHostProvider>,
      { width: 62, height: 14 },
    );

    await act(async () => testSetup!.renderOnce());
    await act(async () => chartShortcut?.(keyEvent("left")));
    await act(async () => testSetup!.renderOnce());
    expect(cursorChanges).toEqual(["2025-01-03T00:00:00.000Z"]);
    const firstCursorFrame = testSetup.captureCharFrame();
    expect(firstCursorFrame).toContain("2025-01-03");
    expect(firstCursorFrame).toContain("────────");

    await act(async () => chartShortcut?.(keyEvent("left")));
    await act(async () => testSetup!.renderOnce());
    expect(cursorChanges).toEqual([
      "2025-01-03T00:00:00.000Z",
      "2025-01-02T00:00:00.000Z",
    ]);
    expect(testSetup.captureCharFrame()).toContain("2025-01-02");

    await act(async () => chartShortcut?.(keyEvent("escape")));
    await act(async () => testSetup!.renderOnce());
    // Escape drops the cursor, so its date leaves the time axis with it.
    expect(testSetup.captureCharFrame()).not.toContain("2025-01-02");
  });

  test("does not emit the same snapped cursor timestamp twice", async () => {
    const cursorChanges: string[] = [];
    testSetup = await testRender(
      <InputHostProvider host={chartInputHost}>
        <CompositeChart
          width={60}
          height={12}
          focused
          series={[series("price", "main", "left", "USD", [100, 103, 101])]}
          panels={[{ id: "main" }]}
          onCursorDateChange={(date) => {
            if (date) cursorChanges.push(date.toISOString());
          }}
        />
      </InputHostProvider>,
      { width: 62, height: 14 },
    );

    await act(async () => testSetup!.renderOnce());
    await act(async () => chartShortcut?.(keyEvent("right")));
    await act(async () => chartShortcut?.(keyEvent("left")));

    expect(cursorChanges).toEqual(["2025-01-01T00:00:00.000Z"]);
  });

  test("zooms with plus and resets the interaction viewport with zero", async () => {
    const viewportChanges: Array<{ start: string; end: string } | null> = [];
    const viewportInteractions: string[] = [];
    testSetup = await testRender(
      <InputHostProvider host={chartInputHost}>
        <CompositeChart
          width={60}
          height={12}
          focused
          series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
          panels={[{ id: "main" }]}
          viewport={{
            start: new Date("2025-01-01T00:00:00.000Z"),
            end: new Date("2025-01-09T00:00:00.000Z"),
          }}
          onViewportChange={(next, interaction) => {
            viewportInteractions.push(interaction);
            viewportChanges.push(next
              ? { start: next.start.toISOString(), end: next.end.toISOString() }
              : null);
          }}
        />
      </InputHostProvider>,
      { width: 62, height: 14 },
    );

    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).toContain("Jan 1");
    expect(viewportChanges).toEqual([]);

    const zoomIn = keyEvent("=");
    zoomIn.sequence = "+";
    zoomIn.shift = true;
    await act(async () => chartShortcut?.(zoomIn));
    await act(async () => testSetup!.renderOnce());

    expect(zoomIn.defaultPrevented).toBe(true);
    expect(testSetup.captureCharFrame()).not.toContain("Jan 1");
    expect(viewportChanges.at(-1)?.start).not.toBe("2025-01-01T00:00:00.000Z");
    expect(viewportInteractions.at(-1)).toBe("zoom");

    await act(async () => chartShortcut?.(keyEvent("0")));
    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).toContain("Jan 1");
    expect(viewportChanges.at(-1)).toBeNull();
    expect(viewportInteractions.at(-1)).toBe("reset");
  });

  test("clears the interaction when zoom returns to the authored viewport", async () => {
    const viewportChanges: Array<{ start: string; end: string } | null> = [];
    testSetup = await testRender(
      <InputHostProvider host={chartInputHost}>
        <CompositeChart
          width={60}
          height={12}
          focused
          series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
          panels={[{ id: "main" }]}
          viewport={{
            start: new Date("2025-01-01T00:00:00.000Z"),
            end: new Date("2025-01-09T00:00:00.000Z"),
          }}
          onViewportChange={(next) => viewportChanges.push(next
            ? { start: next.start.toISOString(), end: next.end.toISOString() }
            : null)}
        />
      </InputHostProvider>,
      { width: 62, height: 14 },
    );

    await act(async () => testSetup!.renderOnce());
    const zoomIn = keyEvent("=");
    zoomIn.sequence = "+";
    zoomIn.shift = true;
    await act(async () => chartShortcut?.(zoomIn));
    await act(async () => testSetup!.renderOnce());
    expect(viewportChanges.at(-1)).not.toBeNull();

    await act(async () => chartShortcut?.(keyEvent("-")));
    await act(async () => testSetup!.renderOnce());

    expect(viewportChanges.at(-1)).toBeNull();
  });

  test("preserves a zoomed viewport when adaptive data refreshes its buffer", async () => {
    const viewportChanges: Array<{ start: string; end: string } | null> = [];
    let replacePoints: ((points: TimeSeriesPoint[]) => void) | null = null;
    const initialPoints = series(
      "price",
      "main",
      "left",
      "USD",
      [100, 101, 102, 103, 104, 105, 106, 107, 108],
    ).points;
    function Harness() {
      const [points, setPoints] = useState(initialPoints);
      replacePoints = setPoints;
      return (
        <InputHostProvider host={chartInputHost}>
          <CompositeChart
            width={60}
            height={12}
            focused
            series={[{
              ...series("price", "main", "left", "USD", []),
              points,
            }]}
            panels={[{ id: "main" }]}
            viewport={{
              start: new Date("2025-01-01T00:00:00.000Z"),
              end: new Date("2025-01-09T00:00:00.000Z"),
            }}
            onViewportChange={(next) => viewportChanges.push(next
              ? { start: next.start.toISOString(), end: next.end.toISOString() }
              : null)}
          />
        </InputHostProvider>
      );
    }

    testSetup = await testRender(
      <Harness />,
      { width: 62, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());

    for (let index = 0; index < 2; index += 1) {
      const zoomIn = keyEvent("=");
      zoomIn.sequence = "+";
      zoomIn.shift = true;
      await act(async () => chartShortcut?.(zoomIn));
      await act(async () => testSetup!.renderOnce());
    }
    const zoomedViewport = viewportChanges.at(-1);
    expect(zoomedViewport?.start).not.toBe("2025-01-01T00:00:00.000Z");
    const changeCount = viewportChanges.length;

    await act(async () => replacePoints?.(initialPoints.slice(2)));
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(viewportChanges).toHaveLength(changeCount);
    expect(viewportChanges.at(-1)).toEqual(zoomedViewport);
  });

  test("keeps a panned viewport when backfill moves beyond the authored range", async () => {
    const viewportChanges: Array<{ start: string; end: string } | null> = [];
    const viewportInteractions: string[] = [];
    let replacePoints: ((points: TimeSeriesPoint[]) => void) | null = null;
    const initialPoints = series(
      "price",
      "main",
      "left",
      "USD",
      [100, 101, 102, 103, 104, 105, 106, 107, 108],
    ).points;
    const olderPoints = Array.from({ length: 11 }, (_, index) => {
      const date = new Date(
        Date.UTC(2024, 11, 25 + index) - (index === 10 ? 60_000 : 0),
      );
      return { date, observedAt: date, value: 90 + index };
    });
    function Harness() {
      const [points, setPoints] = useState(initialPoints);
      replacePoints = setPoints;
      return (
        <InputHostProvider host={chartInputHost}>
          <CompositeChart
            width={60}
            height={12}
            focused
            series={[{
              ...series("price", "main", "left", "USD", []),
              points,
            }]}
            panels={[{ id: "main" }]}
            viewport={{
              start: new Date("2025-01-06T00:00:00.000Z"),
              end: new Date("2025-01-09T00:00:00.000Z"),
            }}
            onViewportChange={(next, interaction) => {
              viewportInteractions.push(interaction);
              viewportChanges.push(next
                ? { start: next.start.toISOString(), end: next.end.toISOString() }
                : null);
            }}
          />
        </InputHostProvider>
      );
    }

    testSetup = await testRender(<Harness />, { width: 62, height: 14 });
    await act(async () => testSetup!.renderOnce());
    for (let index = 0; index < 120; index += 1) {
      const panOlder = keyEvent("left");
      panOlder.shift = true;
      await act(async () => chartShortcut?.(panOlder));
      await act(async () => testSetup!.renderOnce());
    }
    const pannedViewport = viewportChanges.at(-1);
    expect(pannedViewport).toEqual({
      start: "2025-01-01T00:00:00.000Z",
      end: "2025-01-04T00:00:00.000Z",
    });

    await act(async () => replacePoints?.(olderPoints));
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(viewportChanges.at(-1)).toEqual({
      start: "2024-12-31T23:59:00.000Z",
      end: "2025-01-03T23:59:00.000Z",
    });
    expect(viewportInteractions.at(-1)).toBe("sync");
    expect(testSetup.captureCharFrame()).not.toContain("No chart data");
    expect(testSetup.captureCharFrame()).not.toContain("Jan 9");
  });

  test("keeps the latest pan through delayed adaptive viewport and series echoes", async () => {
    const viewportChanges: Array<{ start: string; end: string } | null> = [];
    let publishViewport: ((
      next: { start: string; end: string },
      showSecondary?: boolean,
    ) => void) | null = null;
    let publishExternalViewport: (() => void) | null = null;
    function Harness() {
      const [viewport, setViewport] = useState({
        start: new Date("2025-01-05T00:00:00.000Z"),
        end: new Date("2025-01-09T00:00:00.000Z"),
      });
      const [showSecondary, setShowSecondary] = useState(false);
      const [viewportResetKey, setViewportResetKey] = useState("price:1D:auto");
      publishViewport = (next, nextShowSecondary = showSecondary) => {
        setViewport({
          start: new Date(next.start),
          end: new Date(next.end),
        });
        setShowSecondary(nextShowSecondary);
      };
      publishExternalViewport = () => {
        setViewport({
          start: new Date("2025-01-01T00:00:00.000Z"),
          end: new Date("2025-01-09T00:00:00.000Z"),
        });
        setViewportResetKey("price:1W:auto");
      };
      return (
        <CompositeChart
          width={60}
          height={12}
          interactive
          series={[
            series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108]),
            series("secondary", "main", "left", "USD", showSecondary ? [90, 91, 92] : []),
          ]}
          panels={[{ id: "main" }]}
          viewport={viewport}
          viewportResetKey={viewportResetKey}
          onViewportChange={(next) => {
            viewportChanges.push(next
              ? { start: next.start.toISOString(), end: next.end.toISOString() }
              : null);
          }}
        />
      );
    }

    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <Harness />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());

    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        capturedSurfaceProps!.onMouseScroll(pointerEvent(25, 3, {
          scroll: { direction: "up", delta: 1 },
        }));
      });
      await act(async () => {
        await testSetup!.renderOnce();
        await testSetup!.renderOnce();
      });
    }
    const firstPan = viewportChanges[0]!;
    const latestPan = viewportChanges.at(-1)!;
    expect(firstPan).not.toBeNull();
    expect(latestPan).not.toBeNull();
    expect(latestPan).not.toEqual(firstPan);

    await act(async () => publishViewport!(firstPan, true));
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    expect(viewportChanges).not.toContain(null);
    expect(viewportChanges.at(-1)).toEqual(latestPan);

    await act(async () => publishViewport!(latestPan));
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    expect(viewportChanges).not.toContain(null);
    expect(viewportChanges.at(-1)).toEqual(latestPan);

    for (let index = 0; index < 32; index += 1) {
      await act(async () => {
        capturedSurfaceProps!.onMouseScroll(pointerEvent(25, 3, {
          scroll: { direction: "up", delta: 100 },
        }));
      });
      await act(async () => {
        await testSetup!.renderOnce();
        await testSetup!.renderOnce();
      });
    }
    const boundaryViewport = viewportChanges.at(-1)!;
    expect(boundaryViewport).not.toBeNull();

    await act(async () => publishViewport!(boundaryViewport));
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    const boundaryChangeCount = viewportChanges.length;

    await act(async () => {
      capturedSurfaceProps!.onMouseScroll(pointerEvent(25, 3, {
        scroll: { direction: "up", delta: 100 },
      }));
    });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    expect(viewportChanges).toHaveLength(boundaryChangeCount);
    expect(viewportChanges).not.toContain(null);

    await act(async () => publishExternalViewport!());
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    expect(viewportChanges.at(-1)).toBeNull();
  });

  test("activates and navigates a buffered viewport from the first mouse gesture", async () => {
    let activations = 0;
    const cursorChanges: string[] = [];
    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <CompositeChart
          width={60}
          height={12}
          focused={false}
          interactive
          series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
          panels={[{ id: "main" }]}
          viewport={{
            start: new Date("2025-01-05T00:00:00.000Z"),
            end: new Date("2025-01-09T00:00:00.000Z"),
          }}
          onActivate={() => { activations += 1; }}
          onCursorDateChange={(date) => {
            if (date) cursorChanges.push(date.toISOString());
          }}
        />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );

    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).toContain("Jan 5");

    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(10, 3));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(30, 3));
      capturedSurfaceProps!.onMouseUp(pointerEvent(30, 3));
    });
    await act(async () => testSetup!.renderOnce());

    expect(activations).toBe(1);
    expect(cursorChanges.length).toBeGreaterThan(0);
    expect(testSetup.captureCharFrame()).toContain("Jan 3");
  });

  test("zooms to a shift-drag selection instead of panning", async () => {
    const viewportChanges: Array<{ start: string; end: string } | null> = [];
    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <CompositeChart
          width={60}
          height={12}
          interactive
          series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
          panels={[{ id: "main" }]}
          onViewportChange={(next) => {
            viewportChanges.push(next
              ? { start: next.start.toISOString(), end: next.end.toISOString() }
              : null);
          }}
        />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());

    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(10, 3, { shift: true }));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(30, 3, { shift: true }));
    });
    await act(async () => testSetup!.renderOnce());
    // The selection must not pan the way an unmodified drag would, and the
    // range has to read as text for renderers that cannot draw the band.
    expect(viewportChanges).toHaveLength(0);
    expect(testSetup.captureCharFrame()).toContain("→");

    await act(async () => {
      capturedSurfaceProps!.onMouseUp(pointerEvent(30, 3, { shift: true }));
    });
    await act(async () => testSetup!.renderOnce());

    const zoomed = viewportChanges.at(-1);
    expect(zoomed).toBeTruthy();
    expect(new Date(zoomed!.start).getTime()).toBeGreaterThan(Date.parse("2025-01-01T00:00:00.000Z"));
    expect(new Date(zoomed!.end).getTime()).toBeLessThan(Date.parse("2025-01-09T00:00:00.000Z"));
  });

  test("reports an alt-drag measurement without moving the viewport", async () => {
    const viewportChanges: Array<{ start: string; end: string } | null> = [];
    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <CompositeChart
          width={60}
          height={12}
          interactive
          series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
          panels={[{ id: "main" }]}
          onViewportChange={(next) => {
            viewportChanges.push(next
              ? { start: next.start.toISOString(), end: next.end.toISOString() }
              : null);
          }}
        />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());

    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(8, 6, { alt: true }));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(34, 1, { alt: true }));
    });
    await act(async () => testSetup!.renderOnce());

    const measuringFrame = testSetup.captureCharFrame();
    // The readout sits in the middle of the box it measures, not in the legend.
    expect(measuringFrame).toContain("Δ");
    expect(measuringFrame).toContain("bars");
    expect(measuringFrame.split("\n")[0]).not.toContain("Δ");
    expect(viewportChanges).toHaveLength(0);

    await act(async () => {
      capturedSurfaceProps!.onMouseUp(pointerEvent(34, 1, { alt: true }));
    });
    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).not.toContain("Δ");
    expect(viewportChanges).toHaveLength(0);
  });

  test("arms a measurement from the keyboard when a modifier drag cannot reach the app", async () => {
    testSetup = await testRender(
      <InputHostProvider host={chartInputHost}>
        <CaptureChartSurfaceProvider>
          <CompositeChart
            width={60}
            height={12}
            focused
            interactive
            series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
            panels={[{ id: "main" }]}
          />
        </CaptureChartSurfaceProvider>
      </InputHostProvider>,
      { width: 62, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());

    await act(async () => chartShortcut?.(keyEvent("m", true)));
    await act(async () => testSetup!.renderOnce());

    // No modifier on the drag: the armed tool is what makes it a measurement.
    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(8, 6));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(34, 1));
    });
    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).toContain("Δ");

    await act(async () => {
      capturedSurfaceProps!.onMouseUp(pointerEvent(34, 1));
    });
    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).not.toContain("Δ");

    // Sticky: the tool still owns the next drag until it is dismissed.
    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(8, 6));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(30, 2));
    });
    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).toContain("Δ");
  });

  test("arms and disarms a chart tool from the toolbar", async () => {
    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <CompositeChart
          width={60}
          height={12}
          interactive
          series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
          panels={[{ id: "main" }]}
        />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());

    // Pressing the ruler icon has to arm the tool for an unmodified drag.
    await act(async () => {
      await testSetup!.mockMouse.moveTo(11, 1);
      await testSetup!.mockMouse.click(11, 1);
    });
    await act(async () => testSetup!.renderOnce());
    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(8, 6));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(30, 2));
    });
    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).toContain("Δ");

    await act(async () => {
      capturedSurfaceProps!.onMouseUp(pointerEvent(30, 2));
      await testSetup!.mockMouse.click(11, 1);
    });
    await act(async () => testSetup!.renderOnce());
    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(8, 6));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(30, 2));
    });
    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).not.toContain("Δ");
  });

  test("draws a line, then grabs its end to reshape it", async () => {
    testSetup = await testRender(
      <InputHostProvider host={chartInputHost}>
        <CaptureChartSurfaceProvider>
          <CompositeChart
            width={60}
            height={12}
            focused
            interactive
            series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
            panels={[{ id: "main" }]}
          />
        </CaptureChartSurfaceProvider>
      </InputHostProvider>,
      { width: 62, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());
    await act(async () => chartShortcut?.(keyEvent("d", true)));
    await act(async () => testSetup!.renderOnce());
    const base = capturedSurfaceProps!.bitmaps?.[0] as { pixels: Uint8Array } | undefined;

    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(8, 6));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(30, 2));
      capturedSurfaceProps!.onMouseUp(pointerEvent(30, 2));
    });
    await act(async () => testSetup!.renderOnce());
    const drawn = capturedSurfaceProps!.bitmaps?.[0] as { pixels: Uint8Array } | undefined;
    expect(Buffer.from(drawn!.pixels).equals(Buffer.from(base!.pixels))).toBe(false);

    // Grabbing the endpoint that was just dropped has to reshape, not redraw.
    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(8, 6));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(14, 8));
      capturedSurfaceProps!.onMouseUp(pointerEvent(14, 8));
    });
    await act(async () => testSetup!.renderOnce());
    const reshaped = capturedSurfaceProps!.bitmaps?.[0] as { pixels: Uint8Array } | undefined;
    expect(reshaped).toBeTruthy();
    expect(Buffer.from(reshaped!.pixels).equals(Buffer.from(drawn!.pixels))).toBe(false);
  });

  test("disarms a chart tool with escape", async () => {
    testSetup = await testRender(
      <InputHostProvider host={chartInputHost}>
        <CaptureChartSurfaceProvider>
          <CompositeChart
            width={60}
            height={12}
            focused
            interactive
            series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
            panels={[{ id: "main" }]}
          />
        </CaptureChartSurfaceProvider>
      </InputHostProvider>,
      { width: 62, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());

    await act(async () => chartShortcut?.(keyEvent("z", true)));
    await act(async () => chartShortcut?.(keyEvent("escape")));
    await act(async () => testSetup!.renderOnce());

    // Disarmed: an unmodified drag pans instead of selecting a range.
    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(8, 6));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(30, 2));
    });
    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).not.toContain("→");
  });

  test("keeps a measurement readable in a narrow pane", async () => {
    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <CompositeChart
          width={28}
          height={12}
          interactive
          series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
          panels={[{ id: "main" }]}
        />
      </CaptureChartSurfaceProvider>,
      { width: 30, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());

    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(2, 6, { alt: true }));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(14, 1, { alt: true }));
    });
    await act(async () => testSetup!.renderOnce());

    // Too narrow for the whole summary, but the change still has to be visible.
    expect(testSetup.captureCharFrame()).toContain("Δ");
  });

  test("ends a tool drag whose release landed on another pane", async () => {
    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <CompositeChart
          width={60}
          height={12}
          interactive
          series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
          panels={[{ id: "main" }]}
        />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());

    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(8, 6, { alt: true }));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(34, 1, { alt: true }));
    });
    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).toContain("Δ");

    // No mouse-up arrives: the pointer was released over a floating pane. The
    // next plain move only happens with the button already up.
    await act(async () => {
      capturedSurfaceProps!.onMouseMove(pointerEvent(20, 4));
    });
    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).not.toContain("Δ");
  });

  test("maps the pointer crosshair level through both axes and labels its date", async () => {
    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <CompositeChart
          width={60}
          height={12}
          showLegend={false}
          interactive
          series={[
            series("price", "main", "left", "USD", [100, 200, 100, 100]),
            series("revenue", "main", "right", "%", [0, 200, 0, 0]),
          ]}
          panels={[{ id: "main" }]}
        />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );

    await act(async () => testSetup!.renderOnce());
    const plotWidth = capturedSurfaceNode!.width as number;
    const plotHeight = capturedSurfaceNode!.height as number;
    await act(async () => {
      capturedSurfaceProps!.onMouseMove(pointerEvent(
        (plotWidth - 1) * (2 / 3),
        (plotHeight - 1) / 2,
      ));
    });
    await act(async () => testSetup!.renderOnce());

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("$150");
    expect(frame).toContain("106%");
    expect(frame).toContain("2025-01-03");
    expect(frame).toContain("────────");
  });

  test("zooms around the mouse pointer with control-wheel", async () => {
    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <CompositeChart
          width={60}
          height={12}
          interactive
          series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
          panels={[{ id: "main" }]}
          viewport={{
            start: new Date("2025-01-05T00:00:00.000Z"),
            end: new Date("2025-01-09T00:00:00.000Z"),
          }}
        />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );

    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).toContain("Jan 9");

    await act(async () => {
      capturedSurfaceProps!.onMouseScroll(pointerEvent(25, 3, {
        ctrl: true,
        scroll: { direction: "up", delta: 4 },
      }));
    });
    await act(async () => testSetup!.renderOnce());

    expect(testSetup.captureCharFrame()).not.toContain("Jan 9");
  });

  test("uses a supplied market timeline to keep control-wheel zoom under the pointer", async () => {
    const anchor = twoSessionCandles();
    const display = {
      ...anchor,
      id: "secondary",
      label: "Secondary",
      timeBasis: undefined,
    };
    const viewport = {
      start: new Date(anchor.points[0]!.date.getTime()),
      end: new Date(anchor.points.at(-1)!.date.getTime()),
    };
    const viewportChanges: Array<{ start: string; end: string } | null> = [];
    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <CompositeChart
          width={60}
          height={12}
          interactive
          series={[display]}
          timelineSeries={[anchor]}
          panels={[{ id: "main" }]}
          viewport={viewport}
          onViewportChange={(next) => viewportChanges.push(next
            ? { start: next.start.toISOString(), end: next.end.toISOString() }
            : null)}
        />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );

    await act(async () => testSetup!.renderOnce());
    const pointerX = 35;
    const plotWidth = capturedSurfaceNode!.width as number;
    const minimumSpan = resolveCompositeMinimumSpanMs([display], viewport);
    const expected = zoomCompositeViewport(
      viewport,
      viewport,
      1 + 4 * 0.04,
      pointerX / Math.max(plotWidth - 1, 1),
      minimumSpan,
      [anchor],
    );

    await act(async () => {
      capturedSurfaceProps!.onMouseScroll(pointerEvent(pointerX, 3, {
        ctrl: true,
        scroll: { direction: "up", delta: 4 },
      }));
    });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(viewportChanges.at(-1)).toEqual({
      start: expected.start.toISOString(),
      end: expected.end.toISOString(),
    });
  });

  test("clears a drag interaction when the pointer returns to the authored viewport", async () => {
    const viewportChanges: Array<{ start: string; end: string } | null> = [];
    const interactions: string[] = [];
    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <CompositeChart
          width={60}
          height={12}
          interactive
          series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
          panels={[{ id: "main" }]}
          viewport={{
            start: new Date("2025-01-05T00:00:00.000Z"),
            end: new Date("2025-01-09T00:00:00.000Z"),
          }}
          onViewportChange={(next, interaction) => {
            interactions.push(interaction);
            viewportChanges.push(next
              ? { start: next.start.toISOString(), end: next.end.toISOString() }
              : null);
          }}
        />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );

    await act(async () => testSetup!.renderOnce());
    await act(async () => {
      capturedSurfaceProps!.onMouseDown(pointerEvent(20, 3));
      capturedSurfaceProps!.onMouseDrag(pointerEvent(30, 3));
    });
    await act(async () => testSetup!.renderOnce());
    expect(viewportChanges.at(-1)).not.toBeNull();

    await act(async () => {
      capturedSurfaceProps!.onMouseDrag(pointerEvent(20, 3));
      capturedSurfaceProps!.onMouseUp(pointerEvent(20, 3));
    });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(viewportChanges.at(-1)).toBeNull();
    expect(interactions.at(-1)).toBe("pan");
  });

  test("always treats horizontal control-wheel movement as a pan", async () => {
    const interactions: string[] = [];
    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <CompositeChart
          width={60}
          height={12}
          interactive
          series={[twoSessionCandles()]}
          panels={[{ id: "main" }]}
          viewport={{
            start: new Date("2025-01-03T13:30:00.000Z"),
            end: new Date("2025-01-03T17:00:00.000Z"),
          }}
          onViewportChange={(_next, interaction) => interactions.push(interaction)}
        />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );

    await act(async () => testSetup!.renderOnce());
    await act(async () => {
      capturedSurfaceProps!.onMouseScroll(pointerEvent(25, 3, {
        ctrl: true,
        scroll: { direction: "left", delta: 4 },
      }));
    });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(interactions.at(-1)).toBe("pan");
  });

  test("keeps the date axis and mouse recovery when refreshed data misses the zoomed window", async () => {
    let replacePoints: ((points: TimeSeriesPoint[]) => void) | null = null;
    function Harness() {
      const [points, setPoints] = useState(
        series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108]).points,
      );
      replacePoints = setPoints;
      return (
        <CompositeChart
          width={60}
          height={12}
          interactive
          series={[{
            ...series("price", "main", "left", "USD", []),
            points,
          }]}
          panels={[{ id: "main" }]}
          viewport={{
            start: new Date("2025-01-01T00:00:00.000Z"),
            end: new Date("2025-01-09T00:00:00.000Z"),
          }}
        />
      );
    }

    testSetup = await testRender(
      <CaptureChartSurfaceProvider>
        <Harness />
      </CaptureChartSurfaceProvider>,
      { width: 62, height: 14 },
    );
    await act(async () => testSetup!.renderOnce());

    for (let index = 0; index < 8; index += 1) {
      await act(async () => {
        capturedSurfaceProps!.onMouseScroll(pointerEvent(25, 3, {
          ctrl: true,
          scroll: { direction: "up", delta: 8 },
        }));
      });
      await act(async () => testSetup!.renderOnce());
    }

    await act(async () => {
      replacePoints?.([
        point("2025-01-01", 100),
        point("2025-01-09", 108),
      ]);
    });
    await act(async () => testSetup!.renderOnce());

    // An observation-free window keeps the chart frame and its axes; only the
    // plotted points go away.
    // An observation-free window keeps the chart frame and its axes; only the
    // plotted points go away.
    const emptyFrame = testSetup.captureCharFrame();
    expect(emptyFrame).not.toContain("No chart data");
    expect(emptyFrame).not.toContain("•");
    expect(emptyFrame).toContain("$108");
    expect(emptyFrame).toContain("Jan ");
    expect(typeof capturedSurfaceProps!.onMouseScroll).toBe("function");

    await act(async () => {
      capturedSurfaceProps!.onMouseScroll(pointerEvent(25, 3, {
        ctrl: true,
        scroll: { direction: "down", delta: 4 },
      }));
    });
    await act(async () => testSetup!.renderOnce());

    const recoveredFrame = testSetup.captureCharFrame();
    expect(recoveredFrame).toContain("•");
    expect(recoveredFrame).toContain("2025-01-01");
    expect(recoveredFrame).toContain("Jan 9");
  });

  test("restores persisted drawings from pane settings on mount", async () => {
    const renderWithSettings = async (settings: Record<string, unknown>) => {
      const config = createDefaultConfig("/tmp/gloomberb-composite-drawings");
      config.layout.instances.push({
        instanceId: "chart:test",
        paneId: "chart-composer",
        title: "Chart",
        binding: { kind: "fixed", symbol: "ACME" },
        settings,
      });
      testSetup = await testRender(
        <AppContext value={{ state: createInitialState(config), dispatch: () => {} }}>
          <PaneInstanceProvider paneId="chart:test">
            <CaptureChartSurfaceProvider canvasCharts>
              <CompositeChart
                width={60}
                height={12}
                series={[series("price", "main", "left", "USD", [100, 101, 102, 103, 104, 105, 106, 107, 108])]}
                panels={[{ id: "main" }]}
              />
            </CaptureChartSurfaceProvider>
          </PaneInstanceProvider>
        </AppContext>,
        { width: 62, height: 14 },
      );
      await act(async () => {
        await testSetup!.renderOnce();
        await testSetup!.renderOnce();
      });
      const bitmap = capturedSurfaceProps!.bitmaps?.[0] as { pixels: Uint8Array };
      const pixels = Buffer.from(bitmap.pixels);
      await act(async () => testSetup!.renderer.destroy());
      testSetup = undefined;
      return pixels;
    };

    const blank = await renderWithSettings({});
    const restored = await renderWithSettings({
      chartDrawings: [{
        id: "drawing-1",
        panelId: "main",
        color: "#f5a524",
        points: [
          { time: Date.UTC(2025, 0, 2), value: 101 },
          { time: Date.UTC(2025, 0, 8), value: 107 },
        ],
      }],
    });

    expect(restored.equals(blank)).toBe(false);
  });

  test("shows useful UTC times for an intraday shared cursor and time axis", async () => {
    const intraday = {
      ...series("price", "main", "left", "USD", []),
      points: [
        timestampPoint("2025-01-02T09:30:00.000Z", 100),
        timestampPoint("2025-01-02T12:05:00.000Z", 103),
        timestampPoint("2025-01-02T16:00:00.000Z", 101),
      ],
    };
    testSetup = await testRender(
      <CompositeChart
        width={78}
        height={12}
        series={[intraday]}
        panels={[{ id: "main" }]}
        cursorDate={new Date("2025-01-02T12:05:00.000Z")}
      />,
      { width: 80, height: 14 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("12:05 UTC");
    expect(frame).toContain("09:30 UTC");
    expect(frame).toContain("16:00 UTC");
  });
});
