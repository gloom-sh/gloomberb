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
/** A freehand stroke as the pencil saves it: one point per pointer move. */
const stroke = (id: string, length: number): ChartDrawing => ({
  id, panelId: "main", color: "#4c9aff",
  points: Array.from({ length }, (_, index) => ({ time: 1_700_000_000_000 + index * 60_000, value: 100 + Math.sin(index / 40) })),
});

let latest: AppState;
let dispatch: Dispatch<AppAction>;
let setDrawings: (drawings: readonly ChartDrawing[]) => void;
/** What the chart shows. */
let shown: readonly ChartDrawing[];
let unmount: () => void;

/** A pane holding `stored` drawings, with the store mounted on a chart that starts with none until restored. */
async function mount(stored: readonly unknown[]) {
  const config = createTestPaneConfig("/tmp/gloom-drawing-store", {
    instanceId: PANE_ID,
    paneId: "chart-composer",
    settings: stored.length > 0 ? { [CHART_DRAWINGS_SETTING_KEY]: stored } : {},
  });
  function Chart() {
    const [drawings, set] = useState<readonly ChartDrawing[]>(NO_DRAWINGS);
    setDrawings = set;
    shown = drawings;
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

const saved = () => findPaneInstance(latest.config.layout, PANE_ID)?.settings?.[CHART_DRAWINGS_SETTING_KEY];
const savedIds = () => {
  const list = saved();
  return Array.isArray(list) ? list.map((entry: ChartDrawing) => entry.id) : null;
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

test("a chart with more drawings and freehand points than a link carries reopens with every one, and the next drawing adds to them", async () => {
  const stored = [
    ...Array.from({ length: 101 }, (_, index) => drawing(`line-${index}`)),
    stroke("pencil-1", 2_600),
    stroke("pencil-2", 2_600),
  ];
  await mount(stored);
  await wait(50);
  expect(shown).toEqual(stored);

  await act(async () => setDrawings([...shown, drawing("next")]));
  await wait(500);
  expect(saved()).toEqual([...stored, drawing("next")]);
});

test("an entry the chart cannot read costs only itself: the rest restore, and the next edit keeps them and it", async () => {
  // Written by a build that knows a field this one does not.
  const unreadable = { ...drawing("from-newer-build"), label: "Breakout" };
  await mount([drawing("a"), unreadable, drawing("b")]);
  await wait(50);
  expect(shown.map(({ id }) => id)).toEqual(["a", "b"]);

  await act(async () => setDrawings([...shown, drawing("c")]));
  await wait(500);
  expect(saved()).toEqual([drawing("a"), drawing("b"), drawing("c"), unreadable]);
});

test("drawings the pane restored are left alone when the chart goes untouched", async () => {
  await mount([drawing("kept")]);
  await wait(50);
  await act(async () => unmount());
  await wait(500);
  expect(savedIds()).toEqual(["kept"]);
});
