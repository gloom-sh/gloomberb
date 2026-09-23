import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useState } from "react";
import {
  apiClient,
  type ScannerFeedEvent,
  type ScannerFlowEvent,
  type ScannerFlowHistoryQuery,
} from "../../../api-client";
import { emitKeypress as emitTuiKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import FlowPane from "./flow-pane";

const NOW = Date.now();
const MINUTE = 60_000;

function print(index: number, at: number, overrides: Partial<ScannerFlowEvent> = {}): ScannerFlowEvent {
  return {
    id: `opt-${String(index).padStart(4, "0")}`, at, underlying: index % 2 ? "NVDA" : "TSLA",
    contract: "NVDA261218C00200000", right: "C", strike: 200 + index, expiry: "2026-12-18",
    side: "ask", kind: "sweep", size: 500, price: 10, premium: 500_000,
    volume: 1_000, openInterest: 500, volOi: 2, iv: 0.5, ...overrides,
  };
}

// Newest first: 6 live prints, then 60 recorded ones, all but 5 from yesterday.
const LIVE = Array.from({ length: 6 }, (_, index) => print(index, NOW - index * MINUTE));
const RECORDED = Array.from({ length: 60 }, (_, index) =>
  print(100 + index, index < 5 ? NOW - (10 + index) * MINUTE : NOW - 26 * 60 * MINUTE - index * MINUTE));

/** Reads the wire query back the way the Cloud route does. */
function readQuery(search: string): ScannerFlowHistoryQuery {
  const params = new URLSearchParams(search);
  const number = (key: string) => (params.has(key) ? Number(params.get(key)) : undefined);
  return {
    ...(params.has("beforeAt") ? { before: { at: number("beforeAt")!, id: params.get("beforeId")! } } : {}),
    limit: number("limit"),
    minPremium: number("minPremium"),
  };
}

const originalSubscribe = apiClient.subscribeScanner;
const originalHistory = apiClient.getScannerFlowHistory;
let requests: ScannerFlowHistoryQuery[] = [];
let pushFeed: ((events: ScannerFlowEvent[]) => void) | null = null;
let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

beforeEach(() => {
  requests = [];
  apiClient.subscribeScanner = ((_scanner: string, listener: (event: ScannerFeedEvent) => void) => {
    pushFeed = (events) => listener({
      type: "data",
      payload: { status: "live", access: "realtime", delayMinutes: 0, asOf: Date.now(), events },
    } as ScannerFeedEvent);
    pushFeed(LIVE);
    return () => { pushFeed = null; };
  }) as typeof apiClient.subscribeScanner;
  // Pages the recorded log the way the server does: strictly below the cursor.
  apiClient.getScannerFlowHistory = (async (search: string) => {
    const query = readQuery(search);
    requests.push(query);
    const below = RECORDED.filter((event) => !query.before
      || event.at < query.before.at
      || (event.at === query.before.at && event.id < query.before.id));
    const page = below.slice(0, query.limit ?? 100);
    return { events: page, hasMore: below.length > page.length };
  }) as typeof apiClient.getScannerFlowHistory;
});

afterEach(async () => {
  apiClient.subscribeScanner = originalSubscribe;
  apiClient.getScannerFlowHistory = originalHistory;
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

const PANE_INSTANCE_ID = "scanner-flow:test";
const paneRuntime = createTestPluginRuntime();

function Harness({ height }: { height: number }) {
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-flow-pane-test", {
    paneId: "scanner-flow", instanceId: PANE_INSTANCE_ID,
  }));
  state.paneState = paneState;
  const dispatch = (action: AppAction) => setPaneState(
    (current) => appReducer({ ...state, paneState: current }, action).paneState,
  );
  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_INSTANCE_ID} pluginId="scanner" runtime={paneRuntime}>
      <FlowPane paneId="scanner-flow" paneType="scanner-flow" focused width={100} height={height} />
    </TestPaneProvider>
  );
}

async function settle(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await testSetup!.renderOnce();
    });
  }
}

test("recorded prints fill the pane below the live tape, older days with their date", async () => {
  testSetup = await testRender(<Harness height={24} />, { width: 100, height: 24 });
  await settle();

  // Six live rows cannot fill 21 body rows, so the first page loads by itself,
  // starting under the oldest live print.
  expect(requests[0]).toMatchObject({ limit: 100, minPremium: 250_000, before: { at: LIVE.at(-1)!.at, id: LIVE.at(-1)!.id } });
  const frame = testSetup.captureCharFrame();
  expect(frame).toContain("TIME");
  // Yesterday's rows carry their date, so the whole column shows it.
  expect(frame).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);
  expect(frame).toContain("$500K");
});

test("scrolling to the end asks for the next page from the last recorded print", async () => {
  apiClient.getScannerFlowHistory = (async (search: string) => {
    const query = readQuery(search);
    requests.push(query);
    const below = RECORDED.filter((event) => !query.before
      || event.at < query.before.at
      || (event.at === query.before.at && event.id < query.before.id));
    const page = below.slice(0, 20);
    return { events: page, hasMore: below.length > page.length };
  }) as typeof apiClient.getScannerFlowHistory;
  testSetup = await testRender(<Harness height={12} />, { width: 100, height: 12 });
  await settle();
  expect(requests).toHaveLength(1);

  for (let index = 0; index < 30; index += 1) {
    await emitTuiKeypress(testSetup, { name: "down", sequence: "\u001B[B" });
  }
  await settle();

  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(requests[1]!.before).toEqual({ at: RECORDED[19]!.at, id: RECORDED[19]!.id });
});

test("a print that rolls off the shared tape stays in the pane", async () => {
  testSetup = await testRender(<Harness height={24} />, { width: 100, height: 24 });
  await settle();
  const newest = print(999, NOW + MINUTE, { underlying: "AMD" });
  // The tape now holds only the newest print; the pane keeps the ones it saw.
  await act(async () => {
    pushFeed?.([newest]);
    await testSetup!.renderOnce();
  });
  await settle();
  const frame = testSetup.captureCharFrame();
  expect(frame).toContain("AMD");
  expect(frame.match(/TSLA/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
});
