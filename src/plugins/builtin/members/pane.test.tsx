import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { fundChangesCache, fundListCache, fundMembersCache } from "./client";
import { MembersPane } from "./pane";
import { board, changes } from "./test-fixture";
const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); fundMembersCache.reset(); fundChangesCache.reset(); fundListCache.reset(); });
test("partial holdings keep number columns aligned, open tickers and lazily load the change stack", async () => {
  for (const cache of [fundMembersCache, fundChangesCache, fundListCache]) cache.attach(new MemoryPluginPersistence());
  const calls: string[] = [], pins: string[] = [];
  setCloudApiFetchTransport(async (input) => { const path = new URL(String(input)).pathname; calls.push(path); return Response.json(path.endsWith("/changes") ? changes : board); });
  const initial = createInitialState(createTestPaneConfig(":memory:", { instanceId: "members", paneId: "members", binding: { kind: "fixed", symbol: "SPY" }, settings: {} }));
  function Harness() {
    const [state, setState] = useState(initial);
    const dispatch = (action: AppAction) => setState((previous) => appReducer(previous, action));
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="members" pluginId="members" width={115} height={22}
      runtime={createTestPluginRuntime({ getMarketData: () => null, pinTicker: (symbol) => { pins.push(symbol); } })}>
      {(body) => <MembersPane paneId="members" paneType="members" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 115, height: 22 }); });
  let frame = await tui.waitForFrameToContain("Company AAA");
  expect(frame).toContain("1D 2/3");
  expect(calls.some((path) => path.endsWith("/changes"))).toBe(false);
  const lines = frame.split("\n"), a = lines.find((line) => line.includes("Company AAA"))!, b = lines.find((line) => line.includes("Company BBB"))!;
  expect(a.indexOf("+1.23%") + 6).toBe(b.indexOf("-0.27%") + 6);
  await act(async () => tui.setup().mockInput.pressEnter());
  expect(pins).toEqual(["AAA"]);
  await tui.clickFrameText("Movers");
  await tui.waitForFrameToContain("Detractors");
  await tui.clickFrameText("Changes");
  await tui.waitForFrameToContain("Market capitalization");
  await act(async () => tui.setup().mockInput.pressEnter());
  frame = await tui.waitForFrameToContain("Estimate from IVV share counts");
  expect(frame).toContain("2026-10-12");
});
