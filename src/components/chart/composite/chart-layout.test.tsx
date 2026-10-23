import { afterEach, expect, test } from "bun:test";
import { act, createElement, forwardRef, useMemo, useReducer, useState, type ReactNode } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { InputHostProvider, type InputHost, type KeyEventLike } from "../../../react/input";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { flushPendingPersistence } from "../../../state/persist-scheduler";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createTestResolvedSeries, createTestSeriesPoint as point } from "../../../test-support/time-series";
import { findPaneInstance } from "../../../types/config";
import type { ChartPanelSpec, ResolvedSeries } from "../../../time-series/types";
import { UiHostProvider, useNativeRenderer, useRendererHost, useUiHost, type BoxRenderable } from "../../../ui";
import {
  CHART_LAYOUT_SETTING_KEY,
  draggedPanelWeights,
  movePanelBoundary,
  parseChartLayoutPrefs,
  stepTopPanel,
  weightsFromRows,
} from "./chart-layout";
import { CompositeChart } from "./composite-chart";
import { allocateCompositePanelHeights } from "./scene";

test("a split set by hand lays out at exactly its rows, and keeps its shares when the pane grows", () => {
  // The chart composer's panels: price at its default weight, volume and RSI smaller.
  const specs = [{ id: "main", height: 1 }, { id: "volume", height: 0.24 }, { id: "rsi", height: 0.28 }];
  const weightTotal = specs.reduce((sum, spec) => sum + spec.height, 0);
  const rows = [...allocateCompositePanelHeights(specs, 30).values()];
  // The line above RSI dragged up five rows: volume gives them, price keeps its own.
  const dragged = movePanelBoundary(rows, 2, -5, 2);
  expect(dragged[0]).toBe(rows[0]!);
  expect(dragged[1]! + dragged[2]!).toBe(rows[1]! + rows[2]!);
  expect(Math.min(...dragged)).toBe(2);
  const weights = weightsFromRows(specs.map((spec, index) => ({ id: spec.id, rows: dragged[index]! })), weightTotal);
  const laidOut = (height: number) => [...allocateCompositePanelHeights(specs.map((spec) => ({ id: spec.id, height: weights[spec.id] })), height).values()];
  expect(laidOut(30)).toEqual(dragged);
  expect(laidOut(60)).toEqual(dragged.map((count) => count * 2));
  // A panel added later takes its usual share beside the ones set by hand.
  const withMacd = allocateCompositePanelHeights([...specs.map((spec) => ({ id: spec.id, height: weights[spec.id] })), { id: "macd", height: 0.28 }], 36);
  expect(withMacd.get("macd")).toBe(Math.round(36 * 0.28 / (weightTotal + 0.28)));
});

test("a step of the top panel is undone by a step back, and stops at a panel's minimum", () => {
  const ids = ["main", "volume", "rsi"];
  const layOut = (weights: number[], height: number) => [...allocateCompositePanelHeights(ids.map((id, index) => ({ id, height: weights[index] })), height).values()];
  const step = (weights: number[], height: number, direction: 1 | -1) => {
    const rows = layOut(weights, height);
    const top = stepTopPanel(rows.map((count, index) => ({ rows: count, weight: weights[index]! })), direction, 2);
    return top === null ? null : [top, ...weights.slice(1)];
  };
  // A split dragged by hand, with the panels below of different weights.
  const dragged = [1, 0.17, 0.41];
  const start = layOut(dragged, 34);
  const taller = step(dragged, 34, 1)!;
  expect(layOut(taller, 34)[0]).toBe(start[0]! + 1);
  expect(layOut(step(taller, 34, -1)!, 34)).toEqual(start);
  const shorter = step(dragged, 34, -1)!;
  expect(layOut(shorter, 34)[0]).toBe(start[0]! - 1);
  expect(layOut(step(shorter, 34, 1)!, 34)).toEqual(start);
  // The volume panel at two rows gives no more.
  let weights = dragged;
  for (let next = step(weights, 34, 1); next; next = step(weights, 34, 1)) weights = next;
  expect(layOut(weights, 34)[1]).toBe(2);
  expect(step([1, 1], 4, -1)).toBeNull();
});

test("only what a layout can use is read from the settings", () => {
  expect(parseChartLayoutPrefs({
    panelWeights: { main: 2, volume: -1, rsi: "3", macd: Number.NaN },
    maximizedPanelId: 7,
    toolbarHidden: "yes",
    legendCollapsed: true,
  })).toEqual({ panelWeights: { main: 2 }, legendCollapsed: true });
  expect(parseChartLayoutPrefs([1, 2])).toEqual({});
});

const tui = createOpenTuiTestHarness();
const PANE_ID = "chart-composer:layout";
const runtime = createTestPluginRuntime();
afterEach(async () => {
  await flushPendingPersistence();
});

let chartShortcut: ((event: KeyEventLike) => void) | null = null;
const inputHost: InputHost = {
  useShortcut(handler) {
    chartShortcut = handler;
  },
  useViewport() {
    return { width: 80, height: 24 };
  },
};

function key(name: string, shift = true): KeyEventLike {
  let prevented = false;
  let stopped = false;
  return {
    key: name,
    name,
    sequence: name,
    ctrl: false,
    shift,
    alt: false,
    meta: false,
    get defaultPrevented() { return prevented; },
    get propagationStopped() { return stopped; },
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  };
}

const days = Array.from({ length: 9 }, (_, index) => `2025-01-0${index + 1}`);
const lowerSeries = (id: string, label: string, panelId: string) => createTestResolvedSeries({
  id, label, color: "#ffaa00", unit: "index", unitGroup: "index", axis: "left", panelId,
  points: days.map((day, index) => point(day, 40 + (index % 3) * 10)),
});
const chartSeries = [
  createTestResolvedSeries({
    id: "price", label: "ACME Price", color: "#00ff66", unit: "USD", unitGroup: "currency", axis: "left", panelId: "main",
    points: days.map((day, index) => point(day, 100 + index)),
  }),
  lowerSeries("rsi", "ACME RSI", "lower"),
];
const chartPanels: ChartPanelSpec[] = [{ id: "main", height: 3 }, { id: "lower" }];

type PlotSurfaces = Map<string, { props: Record<string, any>; node: BoxRenderable | null }>;
/** Each panel's plot surface and its node, by panel, to press it as a pointer would. */
let surfaces: PlotSurfaces = new Map();
function CapturePlots({ surfaces, children }: { surfaces: PlotSurfaces; children: ReactNode }) {
  const baseUi = useUiHost();
  const renderer = useRendererHost();
  const nativeRenderer = useNativeRenderer();
  const ui = useMemo(() => {
    const Base = baseUi.ChartSurface;
    const Capturing = forwardRef<any, Record<string, any>>(function Capturing(props, ref) {
      const label = String(props["data-gloom-label"]);
      const entry = surfaces.get(label) ?? { props, node: null };
      entry.props = props;
      surfaces.set(label, entry);
      return createElement(Base as any, {
        ...props,
        ref: (node: BoxRenderable | null) => {
          entry.node = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        },
      });
    });
    return { ...baseUi, ChartSurface: Capturing };
  }, [baseUi, surfaces]);
  return <UiHostProvider ui={ui} renderer={renderer} nativeRenderer={nativeRenderer}>{children}</UiHostProvider>;
}

/** Renders until the chart has laid out what the last change asked for. */
async function settle() {
  for (let pass = 0; pass < 3; pass++) {
    await tui.setup().renderOnce();
    await Bun.sleep(10);
  }
}

/** `change`, its updates committed before the frames that show them are drawn. */
async function commit(change: () => void) {
  await act(async () => change());
  await act(settle);
}

/** A press on a panel's plot as the desktop sends it, `detail` counting the clicks. */
function pressPlot(panel: string, detail: number) {
  const { props, node } = surfaces.get(panel)!;
  const event = {
    x: (node!.x as number) + 10,
    y: (node!.y as number) + 1,
    detail,
    modifiers: { shift: false, alt: false, ctrl: false },
    preventDefault() {},
    stopPropagation() {},
  };
  return commit(() => {
    props.onMouseDown(event);
    props.onMouseUp?.(event);
  });
}

let latest: AppState;
let unmount: () => void;
let setChart: (chart: { series: ResolvedSeries[]; panels: ChartPanelSpec[] }) => void;

async function mount(settings: Record<string, unknown>, initial = { series: chartSeries, panels: chartPanels }) {
  const plots: PlotSurfaces = new Map();
  surfaces = plots;
  const config = createTestPaneConfig("/tmp/gloom-chart-layout", { instanceId: PANE_ID, paneId: "chart-composer", settings });
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, config, createInitialState);
    const [shown, setShown] = useState(true);
    const [chart, set] = useState(initial);
    latest = state;
    unmount = () => setShown(false);
    setChart = set;
    return (
      <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="charts" runtime={runtime}>
        <InputHostProvider host={inputHost}>
          <CapturePlots surfaces={plots}>
            {shown ? <CompositeChart width={60} height={16} focused series={chart.series} panels={chart.panels} /> : null}
          </CapturePlots>
        </InputHostProvider>
      </TestPaneProvider>
    );
  }
  await tui.render(<Harness />, { width: 62, height: 18 });
  await act(settle);
}

const press = (event: KeyEventLike) => commit(() => chartShortcut?.(event));
const lines = () => tui.frame().split("\n");
const savedLayout = () => findPaneInstance(latest.config.layout, PANE_ID)?.settings?.[CHART_LAYOUT_SETTING_KEY];

test("the keys fold the legend and the tool bar and move the panels' line, and the pane keeps them through a restart", async () => {
  await mount({});
  expect(lines()[0]).toContain("ACME RSI");
  expect(tui.frame()).toContain("\u2194");

  await press(key("l"));
  await press(key("t"));
  await press(key("up"));
  await press(key("up"));

  const folded = tui.frame();
  expect(lines()[0]).toContain("ACME Price");
  expect(lines()[0]).toContain("+1");
  expect(lines()[0]).not.toContain("ACME RSI");
  // The tool bar is the one button that brings it back.
  expect(folded).not.toContain("\u2194");
  expect(folded).toContain("\u203a");
  const saved = parseChartLayoutPrefs(savedLayout());
  expect(saved.legendCollapsed).toBe(true);
  expect(saved.toolbarHidden).toBe(true);
  // The top panel's weight alone, against the lower panel's own 1.
  expect(Object.keys(saved.panelWeights ?? {})).toEqual(["main"]);
  expect(saved.panelWeights!.main!).toBeGreaterThan(3);

  // Mounted again from what the pane saved, it opens as it was left.
  const stored = savedLayout();
  await act(async () => unmount());
  await tui.destroy();
  await mount({ [CHART_LAYOUT_SETTING_KEY]: stored });
  expect(tui.frame()).toBe(folded);

  // Open again, nothing is left in the settings.
  await press(key("l"));
  await press(key("t"));
  expect(lines()[0]).toContain("ACME RSI");
  expect(parseChartLayoutPrefs(savedLayout())).toEqual({ panelWeights: saved.panelWeights });
});

const changeChart = (chart: { series: ResolvedSeries[]; panels: ChartPanelSpec[] }) => commit(() => setChart(chart));

test("a double click whose first press was not on the plot leaves it, so a double click on All panels does not maximize again", async () => {
  await mount({});
  // The host counted two clicks, but the first landed elsewhere.
  await pressPlot("lower", 2);
  expect(parseChartLayoutPrefs(savedLayout()).maximizedPanelId).toBeUndefined();
  await pressPlot("lower", 1);
  await pressPlot("lower", 2);
  expect(parseChartLayoutPrefs(savedLayout()).maximizedPanelId).toBe("lower");
  expect(tui.frame()).toContain("All panels");
  // The first click of a double click on the button brings the panels back;
  // its second lands on the plot that is now under it.
  await tui.clickFrameText("All panels");
  await act(settle);
  expect(parseChartLayoutPrefs(savedLayout()).maximizedPanelId).toBeUndefined();
  await pressPlot("main", 2);
  expect(parseChartLayoutPrefs(savedLayout()).maximizedPanelId).toBeUndefined();
  // The price panel's axis is back.
  expect(tui.frame()).toContain("$99.5");
  expect(tui.frame()).not.toContain("All panels");
});

test("a panel saved with the whole chart that the chart no longer has is let go, so it does not come back maximized", async () => {
  await mount({ [CHART_LAYOUT_SETTING_KEY]: { maximizedPanelId: "macd" } });
  expect(savedLayout()).toBeUndefined();
  await changeChart({ series: [...chartSeries, lowerSeries("macd", "ACME MACD", "macd")], panels: [...chartPanels, { id: "macd" }] });
  // The MACD panel draws beside the others.
  expect(tui.frame()).toContain("\u00d7");
  expect(tui.frame()).toContain("$99.5");
  expect(tui.frame()).not.toContain("All panels");
});

test("a panel with the whole chart is kept while its data loads, and let go when a panel is added or it leaves", async () => {
  // A restart: the chart is given the panel before its series has loaded.
  await mount({ [CHART_LAYOUT_SETTING_KEY]: { maximizedPanelId: "lower" } }, { series: chartSeries.slice(0, 1), panels: chartPanels });
  expect(parseChartLayoutPrefs(savedLayout()).maximizedPanelId).toBe("lower");
  await changeChart({ series: chartSeries, panels: chartPanels });
  expect(tui.frame()).toContain("All panels");
  // The legend still reads the price; its axis is gone.
  expect(tui.frame()).not.toContain("$99.5");

  // An indicator added while it is maximized shows with every panel.
  await changeChart({ series: [...chartSeries, lowerSeries("macd", "ACME MACD", "macd")], panels: [...chartPanels, { id: "macd" }] });
  expect(savedLayout()).toBeUndefined();
  expect(tui.frame()).not.toContain("All panels");
  expect(tui.frame()).toContain("$99.5");

  // Maximized and then taken off the chart, it does not come back maximized.
  await pressPlot("lower", 1);
  await pressPlot("lower", 2);
  expect(parseChartLayoutPrefs(savedLayout()).maximizedPanelId).toBe("lower");
  await changeChart({ series: [chartSeries[0]!, lowerSeries("macd", "ACME MACD", "macd")], panels: [chartPanels[0]!, { id: "macd" }] });
  expect(savedLayout()).toBeUndefined();
  await changeChart({ series: chartSeries, panels: chartPanels });
  expect(tui.frame()).not.toContain("All panels");
  expect(tui.frame()).toContain("$99.5");
});

test("hiding the tool bar while a tool in hand holds it open puts the tool down and keeps it hidden", async () => {
  await mount({ [CHART_LAYOUT_SETTING_KEY]: { toolbarHidden: true } });
  expect(tui.frame()).not.toContain("\u2194");
  // The ruler picked from the keys opens the bar while it is in hand.
  await press(key("m"));
  expect(tui.frame()).toContain("\u2194");
  // Hide, as the bar's own chevron does: the bar folds and stays hidden.
  await press(key("t"));
  expect(tui.frame()).not.toContain("\u2194");
  expect(parseChartLayoutPrefs(savedLayout()).toolbarHidden).toBe(true);
  await press(key("t"));
  expect(tui.frame()).toContain("\u2194");
  expect(savedLayout()).toBeUndefined();
});

test("a drag on the line between two panels sets weights only once it has moved a row", () => {
  const start = { rows: [{ id: "main", rows: 12 }, { id: "volume", rows: 3 }, { id: "rsi", rows: 3 }], weightTotal: 1.52 };
  // A click that jitters a pixel or two, and a drag that comes back, keep the split.
  expect(draggedPanelWeights(start, 1, 0.2, 2)).toBeNull();
  expect(draggedPanelWeights(start, 1, -0.4, 2)).toBeNull();
  expect(draggedPanelWeights(start, 1, 0, 2)).toBeNull();
  // Past the volume panel's minimum the line goes no further, and has not moved.
  expect(draggedPanelWeights(start, 1, 3, 2)).toEqual(draggedPanelWeights(start, 1, 1, 2));
  expect(draggedPanelWeights({ ...start, rows: [start.rows[0]!, { id: "volume", rows: 2 }, start.rows[2]!] }, 1, 1, 2)).toBeNull();
  const moved = draggedPanelWeights(start, 1, -2.6, 2)!;
  expect(moved.main! / moved.volume!).toBeCloseTo(9 / 6, 3);
});

