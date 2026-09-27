import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import type { CotBoardPayload, CotBoardRow, CotClassSummary, CotContractPayload } from "../../../api-client/cot";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cotBoardCache } from "./client";
import { CotPane } from "./pane";

const PANE_INSTANCE_ID = "cot:back-test";
const MARKETS = [
  { contractCode: "13874A", marketName: "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE", exchangeCode: "CME", commodityCode: "138" },
  { contractCode: "067651", marketName: "WTI-PHYSICAL - NEW YORK MERCANTILE EXCHANGE", exchangeCode: "NYM", commodityCode: "067" },
  { contractCode: "088691", marketName: "GOLD - COMMODITY EXCHANGE INC.", exchangeCode: "CMX", commodityCode: "088" },
];

function position(): CotClassSummary {
  const percentile = { value: 50, rank: 50, sampleCount: 52, windowStart: "2025-09-15", windowEnd: "2026-09-15",
    historyStart: "2020-01-07", historyEnd: "2026-09-15", completeWindow: true, min: -20, max: 0, mean: -10 };
  return { id: "noncommercial", label: "Noncommercial", long: 10, short: 30, spreading: 0, net: -20, netPercentOfOpenInterest: -10,
    weeklyChange: 5, previousReportDate: "2026-09-08", percentile1Y: percentile,
    percentile3Y: { ...percentile, windowStart: "2023-09-15" } };
}

const base = {
  source: "CFTC", scope: "futures-only", reportFamily: "legacy", generatedAt: "2026-09-22T12:00:00Z", asOf: "2026-09-15",
  fetchedAt: "2026-09-18T20:00:00Z", publishedAt: null, status: "available", gaps: [],
  classes: [{ id: "noncommercial", label: "Noncommercial" }],
} as const;

function board(): CotBoardPayload {
  const rows: CotBoardRow[] = MARKETS.map((market) => ({ ...market, reportDate: "2026-09-15", openInterest: 200,
    position: position(), status: "available" }));
  return { ...base, classes: [...base.classes], gaps: [], traderClass: "noncommercial", rows };
}

function contract(code: string): CotContractPayload {
  return { ...base, classes: [...base.classes], gaps: [], contract: MARKETS.find((market) => market.contractCode === code)!,
    sourceUrl: null, openInterest: 200, positions: [position()],
    history: [{ reportDate: "2026-09-15", openInterest: 200, positions: [{ id: "noncommercial", long: 10, short: 30, spreading: 0, net: -20, netPercentOfOpenInterest: -10 }] }] };
}

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  cotBoardCache.reset();
  spies.push(
    spyOn(apiClient, "getCloudCotBoard").mockImplementation(async () => board()),
    spyOn(apiClient, "getCloudCotContract").mockImplementation(async (code: string) => contract(code)),
    spyOn(apiClient, "getCloudHistory").mockRejectedValue(new Error("price history offline in tests")),
  );
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  cotBoardCache.reset();
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

const paneRuntime = createTestPluginRuntime();

/** A COT pane created by typing COT with CL active: the template puts the code in params. */
function Harness() {
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-cot-pane-test", {
    paneId: "cot", instanceId: PANE_INSTANCE_ID, params: { code: "067651" }, settings: { report: "legacy" },
  }));
  state.paneState = paneState;
  const dispatch = (action: AppAction) => setPaneState(
    (current) => appReducer({ ...state, paneState: current }, action).paneState,
  );
  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_INSTANCE_ID} pluginId="cot" runtime={paneRuntime}>
      <CotPane paneId={PANE_INSTANCE_ID} paneType="cot" focused width={110} height={28} />
    </TestPaneProvider>
  );
}

async function settle(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await testSetup!.renderOnce();
    });
  }
}

async function press(name: string) {
  await emitKeypress(testSetup!, { name, sequence: name.length === 1 ? name : undefined }, { trackPropagation: true });
  await settle();
}

test("Esc leaves a detail opened from params for a board that stays navigable", async () => {
  testSetup = await testRender(<Harness />, { width: 110, height: 28 });
  await settle();

  let frame = testSetup.captureCharFrame();
  expect(frame).toContain("Back");
  expect(frame).toContain("WTI-PHYSICAL");
  expect(frame).not.toContain("MARKET");

  await press("escape");
  frame = testSetup.captureCharFrame();
  // The board, not the deep-linked detail again.
  expect(frame).toContain("MARKET");
  expect(frame).toContain("E-MINI S&P 500");
  expect(frame).toContain("GOLD");
  expect(frame).not.toContain("Back");

  // The cursor starts on the deep-linked row and moves; Enter opens the row under it.
  await press("down");
  await press("return");
  frame = testSetup.captureCharFrame();
  expect(frame).toContain("Back");
  expect(frame).toContain("GOLD");
  expect(frame).not.toContain("MARKET");

  await press("escape");
  frame = testSetup.captureCharFrame();
  expect(frame).toContain("MARKET");
  expect(frame).not.toContain("Back");

  // The board's own keys are live again: / opens the search.
  await press("/");
  await emitKeypress(testSetup, [..."gold"].map((char) => ({ name: char, sequence: char })));
  // The search applies after its input debounce.
  await act(async () => {
    await Bun.sleep(150);
  });
  await settle();
  frame = testSetup.captureCharFrame();
  expect(frame).toContain("GOLD");
  expect(frame).not.toContain("E-MINI S&P 500");
});
