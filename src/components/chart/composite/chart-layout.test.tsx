import { afterEach, expect, test } from "bun:test";
import { act, useReducer, useState, type Dispatch } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { InputHostProvider, type InputHost, type KeyEventLike } from "../../../react/input";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { flushPendingPersistence } from "../../../state/persist-scheduler";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createTestResolvedSeries, createTestSeriesPoint as point } from "../../../test-support/time-series";
import { findPaneInstance } from "../../../types/config";
import {
  CHART_LAYOUT_SETTING_KEY,
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

test("the top panel grows from the tallest panel below and gives back to the shortest", () => {
  expect(stepTopPanel([10, 4, 6], 1, 2)).toEqual([11, 4, 5]);
  expect(stepTopPanel([10, 4, 6], -1, 2)).toEqual([9, 5, 6]);
  expect(stepTopPanel([10, 2, 2], 1, 2)).toBeNull();
  expect(stepTopPanel([2, 9], -1, 2)).toBeNull();
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
const chartSeries = [
  createTestResolvedSeries({
    id: "price", label: "ACME Price", color: "#00ff66", unit: "USD", unitGroup: "currency", axis: "left", panelId: "main",
    points: days.map((day, index) => point(day, 100 + index)),
  }),
  createTestResolvedSeries({
    id: "rsi", label: "ACME RSI", color: "#ffaa00", unit: "index", unitGroup: "index", axis: "left", panelId: "lower",
    points: days.map((day, index) => point(day, 40 + (index % 3) * 10)),
  }),
];

let latest: AppState;
let unmount: () => void;

async function mount(settings: Record<string, unknown>) {
  const config = createTestPaneConfig("/tmp/gloom-chart-layout", { instanceId: PANE_ID, paneId: "chart-composer", settings });
  function Harness() {
    let dispatch: Dispatch<AppAction>;
    [latest, dispatch] = useReducer(appReducer, config, createInitialState);
    const [shown, setShown] = useState(true);
    unmount = () => setShown(false);
    return (
      <TestPaneProvider state={latest} dispatch={dispatch} paneId={PANE_ID} pluginId="charts" runtime={runtime}>
        <InputHostProvider host={inputHost}>
          {shown ? <CompositeChart width={60} height={16} focused series={chartSeries} panels={[{ id: "main", height: 3 }, { id: "lower" }]} /> : null}
        </InputHostProvider>
      </TestPaneProvider>
    );
  }
  await tui.render(<Harness />, { width: 62, height: 18 });
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
}

const press = (event: KeyEventLike) => act(async () => {
  chartShortcut?.(event);
  await tui.setup().renderOnce();
  await tui.setup().renderOnce();
});
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
  expect(Object.keys(saved.panelWeights ?? {}).sort()).toEqual(["lower", "main"]);
  expect(saved.panelWeights!.main! / saved.panelWeights!.lower!).toBeGreaterThan(3);

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
