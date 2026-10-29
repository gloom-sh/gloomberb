import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient } from "../../../api-client";
import type { SwapCurvePayload } from "../../../api-client/swap-curve";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { swapCurveCache } from "./client";
import { SwapsTab } from "./swaps";
import { swapFixture } from "./test-fixture-swaps";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { DataServiceUnreachableError } from "../../../utils/network-failure";

const tui = createOpenTuiTestHarness();
const id = "swap-test";
const runtime = createTestPluginRuntime();
let request: ReturnType<typeof spyOn> | undefined;
afterEach(() => { request?.mockRestore(); swapCurveCache.reset(); });

function Harness() {
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-swap-test", {
    instanceId: id, paneId: "yield-curve", binding: { kind: "none" },
  }));
  initial.focusedPaneId = id;
  const [state, dispatch] = useReducer(appReducer, initial);
  return <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="macro" runtime={runtime} width={100} height={32}>
    {(body) => <SwapsTab focused {...body} />}
  </TestPaneFrame>;
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); await tui.setup().renderOnce(); });
  }
}

test("changing a tenor retains the board while its history loads without relabeling the previous chart", async () => {
  const pending = Promise.withResolvers<SwapCurvePayload>();
  request = spyOn(apiClient, "getCloudSwapCurve").mockImplementation(async (tenor) => tenor === "15Y" ? pending.promise : swapFixture(tenor));
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 32 }); });
  await settle();
  await tui.emitKeypress({ name: "return" });
  await settle();
  expect(tui.frame()).toContain("10Y SOFR");
  await tui.emitKeypress({ name: "down" });
  await settle();
  expect(request.mock.calls.at(-1)?.[0]).toBe("15Y");
  expect(tui.frame()).toContain("Loading history");
  expect(tui.frame()).not.toContain("10Y SOFR");
  expect(tui.frame()).toContain("5Y");
  await act(async () => { pending.resolve(swapFixture("15Y")); });
  await settle();
  expect(tui.frame()).toContain("15Y SOFR");
  expect(tui.frame()).not.toContain("Loading history");
}, 15_000);

// A migrated but unpopulated server returns all nine missing nodes with no date.
test("an undated empty response shows the empty state without a table or stale warning", async () => {
  const payload = swapFixture();
  payload.asOf = null; payload.stale = true;
  payload.points = payload.points.map((point) => ({ ...point, rate: null, changeBp: null, spreadBp: null,
    tradeCount: 0, quality: "missing" }));
  request = spyOn(apiClient, "getCloudSwapCurve").mockResolvedValue(payload);
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 32 }); });
  await tui.waitForFrameToContain("No swap rates yet.");
  expect(tui.frame()).not.toMatch(/stale/i);
  expect(tui.frame()).not.toContain("10Y");
});

test("offline, the board stays and its footer says when the saved copy is from, not a refresh error and stale", async () => {
  swapCurveCache.attach(new MemoryPluginPersistence());
  request = spyOn(apiClient, "getCloudSwapCurve").mockImplementation(async (tenor) => swapFixture(tenor));
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 32 }); });
  await settle();
  expect(tui.frame()).toMatch(/10Y +\d\.\d+%/);

  request.mockRejectedValue(new DataServiceUnreachableError(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })));
  await tui.emitKeypress({ name: "r" });
  await settle();
  expect(tui.frame()).toMatch(/10Y +\d\.\d+%/);
  expect(tui.frame()).toMatch(/saved copy from \d\d:\d\d/);
  expect(tui.frame()).not.toMatch(/stale|couldn't reach/i);
});
