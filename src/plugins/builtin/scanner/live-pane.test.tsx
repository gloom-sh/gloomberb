import { expect, test } from "bun:test";
import { act } from "react";
import type { LiveScanMatch, LiveScanPayload, LiveScanWireDefinition } from "../../../api-client/live-scan";
import type { AppNotificationRequest } from "../../../types/plugin";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { FIRED_LOG_KEY, readFiredAlerts } from "../alerts/fired-log";
import { ALERTS_PLUGIN_ID } from "../alerts/constants";
import { LiveScanClientContext, type LiveScanClient } from "./live-feed";
import LiveScanPane from "./live-pane";

const PANE = "scanner-live:test";
const NOW = Date.now();
const tui = createOpenTuiTestHarness();

const match = (symbol: string, move: number): LiveScanMatch => ({
  symbol, name: `${symbol} Inc`, price: 100, changePercent: move, volume: 2_000_000, relativeVolume: 3.2,
  vwapPercent: 0.4, gapPercent: 0.1, values: [move, 4.5], signalAt: null, at: NOW,
});
const payload = (matches: LiveScanMatch[], takenAt: number): LiveScanPayload => ({
  status: "live", access: "delayed", delayMinutes: 15, asOf: takenAt, takenAt, refreshMs: 60_000,
  scanned: 4_000, matched: matches.length, matches, warmingWindows: [], warnings: [],
});

async function settle(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });
  }
}

test("a refresh redraws the matches, and a new match with alerts on goes out as an alert and into the history", async () => {
  const answers = [payload([match("AAPL", 1.4)], NOW - 30_000), payload([match("AAPL", 1.6), match("NVDA", 2.8)], NOW)];
  const asked: LiveScanWireDefinition[] = [];
  const client: LiveScanClient = {
    getLiveScan: async (definition) => {
      asked.push(definition);
      return answers[Math.min(asked.length - 1, answers.length - 1)]!;
    },
  };
  const notices: AppNotificationRequest[] = [];
  const runtime = createStatefulTestPluginRuntime({ notify: (request) => { notices.push(request); } });
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-live-scan-test", { paneId: "scanner-live", instanceId: PANE }));
  state.paneState[PANE] = { pluginState: { scanner: { alerts: true } } };

  await act(async () => {
    await tui.render(
      <TestPaneProvider state={state} paneId={PANE} pluginId="scanner" runtime={runtime}>
        <LiveScanClientContext value={client}>
          <LiveScanPane paneId="scanner-live" paneType="scanner-live" focused width={110} height={14} />
        </LiveScanClientContext>
      </TestPaneProvider>,
      { width: 110, height: 14 },
    );
  });
  await settle();
  let frame = tui.frame();
  expect(asked[0]).toMatchObject({ version: 1, universe: { kind: "all" }, minPrice: 5, minMarketCap: 300e6 });
  expect(frame).toContain("AAPL");
  expect(frame).toContain("5M CHG");
  expect(frame).toContain("+1.40%");
  // The first answer of a session is what already matched: no alert for it.
  expect(notices).toHaveLength(0);

  await act(async () => {
    tui.setup().mockInput.pressKey("r");
  });
  await settle();
  frame = tui.frame();
  expect(frame).toContain("NVDA");
  expect(frame).toContain("+2.80%");
  expect(frame).toMatch(/NVDA[^\n]*alerted/);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ title: "Live scan", refId: `scan:${PANE}`, desktop: "always" });
  expect(notices[0]!.body).toContain("NVDA matched");
  expect(notices[0]!.body).toContain("(15m delayed)");
  const history = readFiredAlerts(runtime.getResumeState(ALERTS_PLUGIN_ID, FIRED_LOG_KEY));
  expect(history.map((entry) => [entry.kind, entry.symbol, entry.value, entry.source])).toEqual([["live_scan", "NVDA", 2.8, "15 min delayed"]]);
});
