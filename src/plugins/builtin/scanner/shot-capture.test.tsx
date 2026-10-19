import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import HiloPane from "./hilo-pane";
import FlowPane from "./flow-pane";
import { createSnapshotScannerClient, ScannerClientContext, type ScannerCapture } from "../shared/scanner-capture";

const originalSubscribe = apiClient.subscribeScanner;
let socketSubscriptions = 0;
const tui = createOpenTuiTestHarness();

beforeEach(() => {
  socketSubscriptions = 0;
  apiClient.subscribeScanner = (() => { socketSubscriptions += 1; return () => {}; }) as typeof apiClient.subscribeScanner;
});
afterEach(() => { apiClient.subscribeScanner = originalSubscribe; });

async function renderCaptured(pane: "hilo" | "flow", captures: ScannerCapture[]): Promise<string> {
  const paneId = `scanner-${pane}`;
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-scanner-capture-test", { paneId, instanceId: `${paneId}:test` }));
  const Pane = pane === "hilo" ? HiloPane : FlowPane;
  await act(async () => { await tui.render(
    <TestPaneProvider state={state} paneId={`${paneId}:test`} pluginId="scanner" runtime={createTestPluginRuntime()}>
      <ScannerClientContext.Provider value={createSnapshotScannerClient(captures)}>
        <Pane paneId={paneId} paneType={paneId} focused width={100} height={16} />
      </ScannerClientContext.Provider>
    </TestPaneProvider>,
    { width: 100, height: 16 },
  ); });
  for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce(); });
  return tui.frame();
}

// The shot page's own socket is refused by the server, so a scanner pane that asked it never drew anything.
test("a captured refusal draws the sign-in wall and a captured payload draws its rows, without opening the socket", async () => {
  expect(await renderCaptured("flow", [["flow", { type: "denied", reason: "auth_required" }]])).toContain("Sign in to stream the market scanners.");

  const frame = await renderCaptured("hilo", [["hilo", { type: "data", payload: {
    status: "live", access: "realtime", delayMinutes: 0, asOf: Date.now(),
    windows: { s30: { highs: 1, lows: 1 }, m1: { highs: 2, lows: 2 }, m5: { highs: 3, lows: 3 } },
    highs: [{ symbol: "NVDA", price: 120.5, count: 3, at: Date.now() }], lows: [],
  } }]]);
  expect(frame).toContain("NVDA");
  expect(socketSubscriptions).toBe(0);
});
