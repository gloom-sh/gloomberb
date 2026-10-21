import { afterEach, expect, test } from "bun:test";
import { act, useReducer, useState, type Dispatch } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { flushPendingPersistence } from "../../../state/persist-scheduler";
import { findPaneInstance } from "../../../types/config";
import { ChartDrawingStore, NO_DRAWINGS } from "./drawing-store";
import { CHART_DRAWINGS_SETTING_KEY, type ChartDrawing } from "./tools";

const tui = createOpenTuiTestHarness();
const PANE_ID = "chart-composer:drawing-store";
const runtime = createTestPluginRuntime();
afterEach(async () => {
  await flushPendingPersistence();
});

const drawing = (id: string): ChartDrawing => ({
  id, panelId: "main", color: "#ffcc00",
  points: [{ time: 1_700_000_000_000, value: 100 }, { time: 1_700_086_400_000, value: 104 }],
});

let latest: AppState;
let dispatch: Dispatch<AppAction>;
let setDrawings: (drawings: readonly ChartDrawing[]) => void;
let unmount: () => void;

/** A pane holding `stored` drawings, with the store mounted on a chart that starts with none until restored. */
async function mount(stored: readonly ChartDrawing[]) {
  const config = createTestPaneConfig("/tmp/gloom-drawing-store", {
    instanceId: PANE_ID,
    paneId: "chart-composer",
    settings: stored.length > 0 ? { [CHART_DRAWINGS_SETTING_KEY]: stored } : {},
  });
  function Chart() {
    const [drawings, set] = useState<readonly ChartDrawing[]>(NO_DRAWINGS);
    setDrawings = set;
    return <ChartDrawingStore paneInstanceId={PANE_ID} drawings={drawings} onRestore={set} />;
  }
  function Harness() {
    [latest, dispatch] = useReducer(appReducer, config, createInitialState);
    const [shown, setShown] = useState(true);
    unmount = () => setShown(false);
    return (
      <TestPaneProvider state={latest} dispatch={dispatch} paneId={PANE_ID} pluginId="charts" runtime={runtime}>
        {shown ? <Chart /> : null}
      </TestPaneProvider>
    );
  }
  await tui.render(<Harness />, { width: 20, height: 4 });
}

const savedIds = () => {
  const saved = findPaneInstance(latest.config.layout, PANE_ID)?.settings?.[CHART_DRAWINGS_SETTING_KEY];
  return Array.isArray(saved) ? saved.map((entry: ChartDrawing) => entry.id) : null;
};
const wait = (ms: number) => act(async () => { await Bun.sleep(ms); await tui.setup().renderOnce(); });

test("removing the last drawing is saved even when the pane opened with none, and a removal right before the chart goes is saved too", async () => {
  await mount([]);
  await act(async () => setDrawings([drawing("a")]));
  await wait(500);
  expect(savedIds()).toEqual(["a"]);

  // The last one goes: the stored copy must go with it, or it comes back on the next visit.
  await act(async () => setDrawings([]));
  await wait(500);
  expect(savedIds()).toEqual([]);

  await act(async () => setDrawings([drawing("b")]));
  await wait(500);
  await act(async () => setDrawings([]));
  // The chart unmounts inside the write delay, as a tab switch does.
  await act(async () => unmount());
  await wait(50);
  expect(savedIds()).toEqual([]);
});

test("drawings the pane restored are left alone when the chart goes untouched", async () => {
  await mount([drawing("kept")]);
  await wait(50);
  await act(async () => unmount());
  await wait(500);
  expect(savedIds()).toEqual(["kept"]);
});
