import { act, useReducer } from "react";
import { afterEach, expect, spyOn, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { debugLog } from "../../../utils/debug-log";
import { attentionCache } from "./client";
import { HiringPane } from "./pane";
import realHiring from "./fixtures/hiring.json";

const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); attentionCache.reset(); });

test("a handed-in snapshot that does not validate loads the pane's own data and logs no snapshot details", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "company-attention.pane") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    setCloudApiFetchTransport(async () => Response.json(realHiring));
    const id = "hiring:failure";
    const symbol = "ADYEN:AMS";
    const state = createInitialState(createTestPaneConfig("/tmp/hiring-failure-test", { paneId: "hiring", instanceId: id,
      binding: { kind: "fixed" as const, symbol }, settings: { tab: "evidence", attentionSnapshot: { generatedAt: "private", account: "private" } } }));
    state.tickers.set(symbol, createTestTicker(symbol, symbol));
    function Harness() {
      const [current, dispatch] = useReducer(appReducer, state);
      return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
        <HiringPane width={100} height={21} focused />
      </TestPaneProvider>;
    }
    await act(async () => { await tui.render(<Harness />, { width: 100, height: 21 }); });
    await tui.waitForFrameToContain("SENIORITY");
    expect(logged).toEqual([["warn", expect.stringMatching(/^Validate attention snapshot failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
