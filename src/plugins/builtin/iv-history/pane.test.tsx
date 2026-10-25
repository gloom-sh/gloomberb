import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { IvHistoryPane } from "./pane";

const tui = createOpenTuiTestHarness();
afterEach(() => { apiClient.setSessionToken(null); setCloudApiFetchTransport(null); });

test("an FX pair says OTC FX volatility is not covered and which fund stands in, and asks the data service for nothing", async () => {
  const requests: string[] = [];
  setCloudApiFetchTransport(async (url) => { requests.push(String(url)); return Response.json({}); });
  const id = "iv-history:fx";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-iv-history-fx-test", { paneId: "iv-history", instanceId: id, binding: { kind: "fixed", symbol: "EURUSD=X" } }));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneFrame state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()} width={160} height={20}>
      {(body) => <IvHistoryPane paneId={id} paneType="iv-history" {...body} focused />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 160, height: 20 }); });
  const frame = await tui.waitForFrameToContain("OTC FX volatility is not covered for EURUSD=X.");
  expect(frame).toContain("Currency-ETF options are the listed proxy: FXE. HVT shows the pair's realized volatility.");
  expect(requests).toEqual([]);
});
