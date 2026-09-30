import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { apiClient, type ScannerFeedEvent, type ScannerHiloPayload } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
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

beforeEach(() => {
  apiClient.subscribeScanner = ((_scanner: string, listener: (event: ScannerFeedEvent) => void) => {
    pushPayload = (payload) => listener({ type: "data", payload } as ScannerFeedEvent);
    return () => { pushPayload = null; };
  }) as typeof apiClient.subscribeScanner;
});

afterEach(() => {
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
    <TestPaneProvider state={state} paneId={PANE_INSTANCE_ID} pluginId="scanner" runtime={createTestPluginRuntime()}>
      <HiloPane paneId="scanner-hilo" paneType="scanner-hilo" focused width={width} height={height} />
    </TestPaneProvider>,
    { width, height },
  );
  await settle();
}

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
