import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { apiClient, type ScannerFeedEvent } from "../../../api-client";
import { buildDesktopShotPayload } from "../../../cli/pane-functions/screenshot-payload";
import type { ResolvedPaneFunction } from "../../../cli/pane-functions/resolver";
import type { MarketContext } from "../../../cli/types";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import HiloPane from "./hilo-pane";
import FlowPane from "./flow-pane";
import { createSnapshotScannerClient, ScannerClientContext, type ScannerCapture } from "../shared/scanner-capture";

const originalSubscribe = apiClient.subscribeScanner;
const originalHistory = apiClient.getScannerFlowHistory;
let socketSubscriptions = 0;
const tui = createOpenTuiTestHarness();

beforeEach(() => {
  socketSubscriptions = 0;
  apiClient.subscribeScanner = (() => { socketSubscriptions += 1; return () => {}; }) as typeof apiClient.subscribeScanner;
});
afterEach(() => {
  apiClient.subscribeScanner = originalSubscribe;
  apiClient.getScannerFlowHistory = originalHistory;
  setSystemTime();
});

async function renderCaptured(pane: "hilo" | "flow", captures: ScannerCapture[], settings?: Record<string, unknown>): Promise<string> {
  const paneId = `scanner-${pane}`;
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-scanner-capture-test", { paneId, instanceId: `${paneId}:test`, ...(settings ? { settings } : {}) }));
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
  // Signed out, FLOW asks for a sign-in but names the Pro lock a free account would still meet, and what is free.
  const wall = await renderCaptured("flow", [["flow", { type: "denied", reason: "auth_required" }]]);
  expect(wall).toContain("Sign in to stream options flow with Gloom Cloud Pro.");
  expect(wall).toContain("Options flow is Pro. Free: OMON chain, price and move alerts.");
  expect(await renderCaptured("hilo", [["hilo", { type: "denied", reason: "auth_required" }]])).toContain("Sign in to stream the market scanners.");

  const frame = await renderCaptured("hilo", [["hilo", { type: "data", payload: {
    status: "live", access: "realtime", delayMinutes: 0, asOf: Date.now(),
    windows: { s30: { highs: 1, lows: 1 }, m1: { highs: 2, lows: 2 }, m5: { highs: 3, lows: 3 } },
    highs: [{ symbol: "NVDA", price: 120.5, count: 3, at: Date.now() }], lows: [],
  } }]]);
  expect(frame).toContain("NVDA");
  expect(socketSubscriptions).toBe(0);
});

// A cold scanner answers `starting` while it seeds, and a pane's feed drops a starting payload to wait for the next. The
// page replays only the captured answer, so a capture that kept it left FLOW on "Waiting for the scanner..." until the
// screenshot timed out (`gloom shot FLOW NVDA` overnight).
test("a FLOW capture taken while the market is shut draws the closed session when a cold scanner answered starting", async () => {
  // Tue 24 Nov 2026 01:52 New York: the night between after-hours and the pre-market.
  setSystemTime(new Date("2026-11-24T06:52:00Z"));
  const request = { pane: { id: "scanner-flow" }, capability: { id: "scanner-flow-pane", options: [] },
    instance: { instanceId: "flow:test", paneId: "scanner-flow", binding: { kind: "none" }, settings: { symbol: "NVDA" } }, options: {},
  } as unknown as ResolvedPaneFunction;
  const context = { config: createDefaultConfig("/tmp/gloomberb-scanner-capture-test"), store: { loadTicker: async () => null },
    dataProvider: { id: "offline" } } as unknown as MarketContext;
  const starting: ScannerFeedEvent = { type: "data", payload: { status: "starting", access: "realtime", delayMinutes: 0, asOf: Date.now(), events: [] } };
  // The cold scanner says nothing more before the capture is taken.
  const shot = await buildDesktopShotPayload(request, context, "", {}, 800, 600, null, 1, null, undefined, {
    subscribeScanner(_scanner, listener) { listener(starting); return () => {}; },
  });

  const at = Date.parse("2026-11-23T20:42:00Z");
  apiClient.getScannerFlowHistory = (async () => ({ hasMore: false, events: [{
    id: "opt-1", at, underlying: "NVDA", contract: "NVDA270115C00180000", right: "C", strike: 180, expiry: "2027-01-15",
    side: "ask", kind: "block", size: 7_500, price: 8.7, premium: 6_525_000, volume: 9_000, openInterest: 15_000, volOi: 0.6, iv: 0.45,
  }] })) as typeof apiClient.getScannerFlowHistory;
  const frame = await renderCaptured("flow", shot.scannerSnapshots ?? [], { symbol: "NVDA" });
  expect(frame).not.toContain("Waiting for the scanner");
  expect(frame).toContain("$6.5M");
});
