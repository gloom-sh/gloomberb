import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { apiClient, type ScannerFeedEvent, type ScannerHiloPayload } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { formatDetailDate } from "../../../utils/datetime-format";
import HiloPane from "./hilo-pane";

const PANE_INSTANCE_ID = "scanner-hilo:test";
const NOW = Date.now();
const PAYLOAD: ScannerHiloPayload = {
  status: "live", access: "realtime", delayMinutes: 0, asOf: NOW,
  windows: { m5: { highs: 42, lows: 17 }, m1: { highs: 9, lows: 130 }, s30: { highs: 3, lows: 0 } },
  highs: [{ symbol: "NVDA", price: 120.5, count: 3, at: NOW }],
  lows: [{ symbol: "TSLA", price: 200.1, count: 2, at: NOW }],
};

const originalSubscribe = apiClient.subscribeScanner;
let pushPayload: ((payload: ScannerHiloPayload) => void) | null = null;
const tui = createOpenTuiTestHarness();

/** Wednesday 18 Nov 2026 10:00 New York: the US session is open. */
const OPEN = new Date("2026-11-18T15:00:00Z");

beforeEach(() => {
  setSystemTime(OPEN);
  apiClient.subscribeScanner = ((_scanner: string, listener: (event: ScannerFeedEvent) => void) => {
    pushPayload = (payload) => listener({ type: "data", payload } as ScannerFeedEvent);
    return () => { pushPayload = null; };
  }) as typeof apiClient.subscribeScanner;
});

afterEach(() => {
  setSystemTime();
  apiClient.subscribeScanner = originalSubscribe;
  pushPayload = null;
});

async function settle(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });
  }
}

async function renderPane(width: number, height = 14) {
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-hilo-pane-test", {
    paneId: "scanner-hilo", instanceId: PANE_INSTANCE_ID,
  }));
  await tui.render(
    <TestPaneFrame state={state} paneId={PANE_INSTANCE_ID} pluginId="scanner" runtime={createTestPluginRuntime()} width={width} height={height}>
      {(body) => <HiloPane paneId="scanner-hilo" paneType="scanner-hilo" focused {...body} />}
    </TestPaneFrame>,
    { width, height },
  );
  await settle();
}

test("a delayed stream's live status never labels the data live, even after an access change", async () => {
  await renderPane(110);
  await deliver(PAYLOAD);
  expect(tui.frame()).toMatch(/\blive\b/);

  const observed = Date.parse("2026-11-18T14:48:00Z");
  await deliver({ ...PAYLOAD, access: "delayed", delayMinutes: 15, asOf: observed });
  expect(tui.frame()).toContain("15m delayed");
  expect(tui.frame()).toContain(`as of ${formatDetailDate(observed)}`);
  expect(tui.frame()).not.toMatch(/\blive\b/);
});

async function deliver(payload: ScannerHiloPayload) {
  await act(async () => {
    pushPayload!(payload);
  });
  await settle();
}

test("the window bars wait for the first payload instead of showing zero counts", async () => {
  await renderPane(80);
  let frame = tui.frame();
  expect(frame).toContain("Waiting for the scanner");
  expect(frame).not.toContain("5 min");
  expect(frame).not.toContain("30 sec");

  await deliver(PAYLOAD);
  frame = tui.frame();
  expect(frame).toContain("5 min");
  expect(frame).toContain("TSLA");
});

test("counts keep a gap from the window label, and the top row names the sides", async () => {
  await renderPane(80);
  await deliver(PAYLOAD);
  const lines = tui.frame().split("\n");
  const top = lines.find((line) => line.includes("5 min"))!;
  const middle = lines.find((line) => line.includes("1 min"))!;
  const bottom = lines.find((line) => line.includes("30 sec"))!;
  expect(top).toMatch(/17 {2,}5 min {2,}42/);
  expect(middle).toMatch(/130 {2,}1 min {2,}9/);
  expect(bottom).toMatch(/0 {2,}30 sec {2,}3/);
  expect(top.trimStart().startsWith("LOWS")).toBe(true);
  expect(top.trimEnd().endsWith("HIGHS")).toBe(true);
  // Only the top row carries the names; the window labels line up down the column.
  expect(middle).not.toContain("LOWS");
  expect(top.indexOf("5 min")).toBe(middle.indexOf("1 min"));

  // Too narrow for the names: the bars take the cells back and the gaps stay.
  await renderPane(44);
  await deliver(PAYLOAD);
  const narrow = tui.frame();
  expect(narrow).not.toContain("LOWS");
  expect(narrow).not.toContain("HIGHS");
  expect(narrow).toMatch(/17 {2,}5 min {2,}42/);
});

test("a closed market is named in both tables from the calendar, before the scanner answers and whatever it says; an open one with no rows names the price filter", async () => {
  const empty = { ...PAYLOAD, highs: [], lows: [], windows: { m5: { highs: 0, lows: 0 }, m1: { highs: 0, lows: 0 }, s30: { highs: 0, lows: 0 } } };
  const closed = (frame: string) => {
    expect(frame.match(/Markets closed until Mon 14:30 UTC, 09:30 ET\./g)).toHaveLength(2);
    expect(frame.match(/New highs and lows resume at the open\./g)).toHaveLength(2);
    expect(frame).toContain("market closed");
    expect(frame).not.toContain("price filter");
    expect(frame).not.toContain("Waiting for the scanner");
  };
  setSystemTime(new Date("2026-10-31T16:00:00Z"));
  await renderPane(100);
  closed(tui.frame());
  await deliver({ ...empty, status: "closed" });
  closed(tui.frame());
  // A warm scanner holding an empty session it calls live changes nothing while the market is shut.
  await deliver({ ...empty, status: "live" });
  closed(tui.frame());

  setSystemTime(OPEN);
  await renderPane(100);
  await deliver({ ...empty, status: "live" });
  const frame = tui.frame();
  expect(frame.match(/Nothing above the price filter yet\./g)).toHaveLength(2);
  expect(frame).not.toContain("closed");
});
