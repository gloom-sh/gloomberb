import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient } from "../../../api-client";
import type { DoeBoardPayload } from "../../../api-client/doe";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { DataServiceUnreachableError } from "../../../utils/network-failure";
import { doeBoardCache } from "./client";
import { DoePane } from "./pane";

const tui = createOpenTuiTestHarness();
const id = "doe:test";
let board: ReturnType<typeof spyOn> | undefined;
afterEach(() => { board?.mockRestore(); doeBoardCache.reset(); });

const BOARD: DoeBoardPayload = {
  source: "EIA", generatedAt: "2026-10-22T15:00:00.000Z", status: "available", gaps: [],
  reports: [{ id: "gas", weekEnding: "2026-10-16", releasedAt: "2026-10-22T14:30:00.000Z", releaseHoliday: null,
    nextWeekEnding: "2026-10-23", nextReleaseAt: "2026-10-29T14:30:00.000Z", nextReleaseHoliday: null }],
  series: [{
    id: "gas-lower-48", key: "NW2_EPG0_SWO_R48_BCF", report: "gas", tab: "gas", label: "Lower 48", unit: "bcf",
    weekEnding: "2026-10-16", value: 3_644, previousWeekEnding: "2026-10-09", weekChange: 77,
    yearAgo: null, fiveYear: null, read: null, seasonal: null,
  }],
};

function Harness() {
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-doe-test", {
    instanceId: id, paneId: "doe", binding: { kind: "none" }, settings: { tab: "gas" },
  }));
  initial.focusedPaneId = id;
  const [state, dispatch] = useReducer(appReducer, initial);
  return <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="doe" runtime={createTestPluginRuntime()} width={100} height={24}>
    {(body) => <DoePane paneId={id} paneType="doe" focused {...body} />}
  </TestPaneFrame>;
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); await tui.setup().renderOnce(); });
  }
}

test("offline, the board stays and its footer says when the saved copy is from, not the refresh error", async () => {
  doeBoardCache.attach(new MemoryPluginPersistence());
  board = spyOn(apiClient, "getCloudDoeBoard").mockResolvedValue(BOARD);
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 24 }); });
  await settle();
  expect(tui.frame()).toMatch(/Lower 48 .*3,644/);

  board.mockRejectedValue(new DataServiceUnreachableError(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })));
  await tui.emitKeypress({ name: "r" });
  await settle();
  expect(tui.frame()).toMatch(/Lower 48 .*3,644/);
  expect(tui.frame()).toMatch(/saved copy from \d\d:\d\d/);
  expect(tui.frame()).not.toMatch(/stale|couldn't reach/i);
});
