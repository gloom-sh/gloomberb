import { afterEach, expect, test } from "bun:test";
import { act, useReducer, type Dispatch } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { flushPendingPersistence } from "../../../state/persist-scheduler";
import { usePinnedTabTime, useUnpinTab } from "../../../state/app/tab-cursor";
import { findPaneInstance } from "../../../types/config";
import { CHART_PINNED_MOMENT_SETTING_KEY } from "./chart-spec";
import { ChartComposerPane } from "./pane";
import { buildPriceChartPreset } from "./presets";

const tui = createOpenTuiTestHarness();
const PANE_ID = "chart-composer:shared-moment";
let latest: AppState;
let dispatch: Dispatch<AppAction>;
let pinnedAt: number | null = null;
let unpin = () => {};
afterEach(async () => {
  await act(async () => unpin());
  await flushPendingPersistence();
});

/** A chart opened from a shared link, its pane holding the link's moment. */
async function open(moment: unknown) {
  const config = createTestPaneConfig("/tmp/gloom-shared-moment", {
    instanceId: PANE_ID,
    paneId: "chart-composer",
    settings: { chartSpec: buildPriceChartPreset("ACME:NASDAQ"), [CHART_PINNED_MOMENT_SETTING_KEY]: moment },
  });
  const provider = createTestDataProvider({
    getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    getPriceHistoryForResolution: async () => [],
  });
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  function Probe() {
    pinnedAt = usePinnedTabTime();
    unpin = useUnpinTab();
    return null;
  }
  function Harness() {
    [latest, dispatch] = useReducer(appReducer, config, createInitialState);
    return (
      <TestPaneProvider state={latest} dispatch={dispatch} paneId={PANE_ID} pluginId="charts" runtime={runtime}>
        <Probe />
        <ChartComposerPane paneId={PANE_ID} paneType="chart-composer" focused width={90} height={20} />
      </TestPaneProvider>
    );
  }
  await tui.render(<Harness />, { width: 90, height: 22 });
  await act(async () => { await Bun.sleep(50); await tui.setup().renderOnce(); });
}

const held = () => findPaneInstance(latest.config.layout, PANE_ID)?.settings?.[CHART_PINNED_MOMENT_SETTING_KEY] ?? null;

test("a shared moment pins the tab once and leaves the pane; an implausible one pins nothing and goes too", async () => {
  const moment = Date.parse("2026-10-15T14:30:00.000Z");
  await open(moment);
  expect(pinnedAt).toBe(moment);
  expect(held()).toBeNull();
  await act(async () => unpin());
  expect(pinnedAt).toBeNull();

  // Past the Date range, year 275760, 1850, two years ahead, not a number.
  const year = 365 * 86_400_000;
  for (const untrusted of [1e20, 8.64e15, Date.UTC(1850, 0, 1), Date.now() + 2 * year, "1760538600000", { at: moment }]) {
    await open(untrusted);
    expect(pinnedAt).toBeNull();
    expect(held()).toBeNull();
  }
});
