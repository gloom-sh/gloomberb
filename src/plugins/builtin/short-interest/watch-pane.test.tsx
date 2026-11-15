import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import * as watchClient from "./watch-client";
import { buildShortWatchRow } from "./watch-model";
import { ShortWatchPane } from "./watch-pane";

const tui = createOpenTuiTestHarness();
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

test("unreported and failed tickers keep their own row and reason through refresh and recovery", async () => {
  let error: string | null = null;
  let recovered = false;
  const load = spyOn(watchClient, "loadShortWatch").mockImplementation(async () => [
    buildShortWatchRow({ symbol: "GME", records: [], floatShares: null, history: [] }),
    buildShortWatchRow({ symbol: "HOOD", records: recovered ? [{ settlementDate: new Date("2026-10-30T00:00:00Z"),
      sharesShort: 35_247_620, shortRatio: 1.75, averageDailyVolume: null, shortPercentFloat: null }] : [],
      floatShares: null, history: recovered ? [{ date: new Date("2026-11-13T00:00:00Z"), close: 10 }] : [], error }),
  ]);
  restore = () => load.mockRestore();
  const state = createInitialState(createTestPaneConfig("/unused-short-watch-test", { instanceId: "watch", paneId: "short-watch",
    settings: { scope: "custom", symbols: "GME,HOOD" } }));
  await act(async () => { await tui.render(
    <TestPaneProvider state={state} paneId="watch" pluginId="short-interest" runtime={createTestPluginRuntime()}>
      <ShortWatchPane focused width={90} height={18} />
    </TestPaneProvider>, { width: 90, height: 18 }); });
  await settleFrame(tui.setup(), 10);
  expect(tui.frame().split("\n").find((line) => /^\s*HOOD\s/.test(line)), tui.frame()).toContain("No short interest reported");
  error = "Settlement lookup failed";
  await tui.emitKeypress({ name: "r" });
  await settleFrame(tui.setup(), 10);
  expect(tui.frame().split("\n").find((line) => /^\s*HOOD\s/.test(line))).toContain(error);
  error = null;
  recovered = true;
  await tui.emitKeypress({ name: "r" });
  await settleFrame(tui.setup(), 10);
  const hood = tui.frame().split("\n").find((line) => /^\s*HOOD\s/.test(line))!;
  expect(hood).toContain("No month of daily closes");
  expect(hood).toContain("35.25M");
  expect(hood).not.toContain("lookup failed");
});
