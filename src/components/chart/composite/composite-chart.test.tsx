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

function CaptureChartSurfaceProvider({ children }: { children: ReactNode }) {
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
    () => ({ ...baseUi, ChartSurface: CapturingChartSurface }),
    [CapturingChartSurface, baseUi],
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
    scroll?: { direction: "up" | "down" | "left" | "right"; delta: number };
  } = {},
) {
  const node = capturedSurfaceNode!;
  return {
    x: (node.x as number) + localX,
    y: (node.y as number) + localY,
    modifiers: { shift: false, alt: false, ctrl: options.ctrl === true },
    scroll: options.scroll,
    preventDefault() {},
    stopPropagation() {},
  };
}

function keyEvent(name: string): KeyEventLike {
  let defaultPrevented = false;
  let propagationStopped = false;
  return {
    key: name,
    name,
    sequence: name,
    ctrl: false,
    shift: false,
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
  if (!testSetup) return;
  await act(async () => testSetup!.renderer.destroy());
  testSetup = undefined;
  chartShortcut = null;
  capturedSurfaceProps = null;
  capturedSurfaceNode = null;
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

describe("CompositeChart", () => {
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

  test("shows an explicit legend toggle action on hover", async () => {
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
    const firstLegendLine = testSetup.captureCharFrame().split("\n")[0]!;
    const priceColumn = firstLegendLine.indexOf("ACME Price");
    expect(priceColumn).toBeGreaterThan(0);

    await act(async () => {
      await testSetup!.mockMouse.moveTo(2, 5);
      await testSetup!.mockMouse.moveTo(priceColumn, 0);
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame().split("\n")[0]).toContain("Hide");

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
    expect(testSetup.captureCharFrame()).toContain("Latest");
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

    await act(async () => chartShortcut?.(keyEvent("0")));
    await act(async () => testSetup!.renderOnce());
    expect(testSetup.captureCharFrame()).toContain("Jan 1");
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

    const emptyFrame = testSetup.captureCharFrame();
    expect(emptyFrame).toContain("No chart data");
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
    expect(recoveredFrame).not.toContain("No chart data");
    expect(recoveredFrame).toContain("2025-01-01");
    expect(recoveredFrame).toContain("Jan 9");
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
    expect(frame).toContain("2025-01-02 12:05 UTC");
    expect(frame).toContain("09:30 UTC");
    expect(frame).toContain("16:00 UTC");
  });
});
