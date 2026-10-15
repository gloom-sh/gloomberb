import { afterEach, expect, test } from "bun:test";
import { act, useReducer, type Dispatch } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { flushPendingPersistence } from "../../../state/persist-scheduler";
import { findPaneInstance, type AppConfig } from "../../../types/config";
import { CHART_INTERACTION_VIEWPORT_SETTING_KEY } from "./chart-spec";
import { ChartComposerPane } from "./pane";
import { buildPriceChartPreset } from "./presets";
import { CHART_RANGES } from "./settings";

const tui = createOpenTuiTestHarness();
const PANE_ID = "chart-composer:range-reselect";
let latest: AppState;
let dispatch: Dispatch<AppAction>;
afterEach(async () => {
  await flushPendingPersistence();
});

/** A year of daily bars ending today, so a range has room to be zoomed into. */
const HISTORY = Array.from({ length: 400 }, (_, index) => ({
  date: new Date(Date.now() - (399 - index) * 86_400_000),
  open: 100 + index / 10,
  high: 101 + index / 10,
  low: 99 + index / 10,
  close: 100 + index / 10,
  volume: 1_000,
}));

/** The pane as a layout holds it: a price chart on `range`, or the config an earlier mount left. */
async function mount(range: (typeof CHART_RANGES)[number], saved?: AppConfig) {
  const spec = buildPriceChartPreset("ACME:NASDAQ");
  const config = saved ?? createTestPaneConfig("/tmp/gloom-range-reselect", {
    instanceId: PANE_ID,
    paneId: "chart-composer",
    settings: { chartSpec: { ...spec, viewport: { ...spec.viewport, range, resolution: "1d" } } },
  });
  const provider = createTestDataProvider({
    getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    getPriceHistoryForResolution: async () => HISTORY,
  });
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  function Harness() {
    [latest, dispatch] = useReducer(appReducer, config, createInitialState);
    return (
      <TestPaneProvider state={latest} dispatch={dispatch} paneId={PANE_ID} pluginId="charts" runtime={runtime}>
        <ChartComposerPane paneId={PANE_ID} paneType="chart-composer" focused width={110} height={25} />
      </TestPaneProvider>
    );
  }
  await tui.render(<Harness />, { width: 110, height: 28 });
}

async function settle(predicate: () => boolean, ms = 2_500) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await act(async () => { await Bun.sleep(20); await tui.setup().renderOnce(); });
    if (predicate()) return;
  }
  throw new Error(`Chart did not settle:\n${tui.frame()}`);
}

const savedView = () => findPaneInstance(latest.config.layout, PANE_ID)?.settings?.[CHART_INTERACTION_VIEWPORT_SETTING_KEY];
const selectedKey = (range: string) => String(CHART_RANGES.indexOf(range as (typeof CHART_RANGES)[number]) + 1);

test("the selected range, pressed again, clears the view a pan or zoom saved with the pane; a different range is unchanged", async () => {
  await mount("1Y");
  await settle(() => tui.frame().includes("ACME"));
  // Not moved: the press changes and saves nothing.
  const before = JSON.stringify(findPaneInstance(latest.config.layout, PANE_ID)?.settings);
  await tui.emitKeypress({ name: selectedKey("1Y"), sequence: selectedKey("1Y") });
  await act(async () => { await Bun.sleep(450); await tui.setup().renderOnce(); });
  expect(savedView()).toBeUndefined();
  expect(JSON.stringify(findPaneInstance(latest.config.layout, PANE_ID)?.settings)).toBe(before);

  // Zoomed: the chart tells its pane, which saves the view once the zoom settles.
  await tui.emitKeypress({ name: "=", sequence: "+", shift: true });
  await settle(() => savedView() != null);

  await tui.emitKeypress({ name: selectedKey("1Y"), sequence: selectedKey("1Y") });
  await settle(() => savedView() == null);
  const spec = findPaneInstance(latest.config.layout, PANE_ID)?.settings?.chartSpec as { viewport: { range: string } };
  expect(spec.viewport.range).toBe("1Y");

  // A different range is the ordinary change: the spec moves and the saved view goes with it.
  await tui.emitKeypress({ name: "=", sequence: "+", shift: true });
  await settle(() => savedView() != null);
  await tui.emitKeypress({ name: selectedKey("6M"), sequence: selectedKey("6M") });
  await settle(() => (findPaneInstance(latest.config.layout, PANE_ID)?.settings?.chartSpec as { viewport: { range: string } }).viewport.range === "6M");
  expect(savedView() ?? null).toBeNull();
});

test("a view the pane saved and restored is cleared by the selected range too, though the chart holds none of its own", async () => {
  await mount("1Y");
  await settle(() => tui.frame().includes("ACME"));
  await tui.emitKeypress({ name: "=", sequence: "+", shift: true });
  await settle(() => savedView() != null);
  const saved = latest.config;
  await tui.destroy();

  await mount("1Y", saved);
  await settle(() => tui.frame().includes("ACME"));
  expect(savedView()).toBeDefined();
  await tui.emitKeypress({ name: selectedKey("1Y"), sequence: selectedKey("1Y") });
  await settle(() => savedView() == null);
});
