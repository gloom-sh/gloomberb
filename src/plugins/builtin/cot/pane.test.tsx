import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import type { CotBoardPayload, CotBoardRow, CotClass, CotClassSummary, CotContractPayload } from "../../../api-client/cot";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
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

function position(id: CotClass = "noncommercial", label = "Noncommercial", long = 10, short = 30): CotClassSummary {
  const percentile = { value: 50, rank: 50, sampleCount: 52, windowStart: "2025-09-15", windowEnd: "2026-09-15",
    historyStart: "2020-01-07", historyEnd: "2026-09-15", completeWindow: true, min: -20, max: 0, mean: -10 };
  return { id, label, long, short, spreading: 0, net: long - short, netPercentOfOpenInterest: -10,
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

/** Twenty weekly reports for the three legacy classes, oldest first, ending on the latest report. */
function charted(code: string): CotContractPayload {
  const classes = [
    { id: "noncommercial", label: "Noncommercial", long: 360_000, short: 220_000 },
    { id: "commercial", label: "Commercial", long: 850_000, short: 1_020_000 },
    { id: "nonreportable", label: "Nonreportable", long: 76_000, short: 47_000 },
  ] as const;
  const history = Array.from({ length: 20 }, (_, index) => {
    const reportDate = new Date(Date.UTC(2026, 4, 5) + index * 7 * 86_400_000).toISOString().slice(0, 10);
    return { reportDate, openInterest: 1_800_000, positions: classes.map((row) => {
      const long = row.long + index * 1_000;
      return { id: row.id, long, short: row.short, spreading: 0, net: long - row.short, netPercentOfOpenInterest: 1 };
    }) };
  });
  const latest = history.at(-1)!;
  return { ...contract(code), asOf: latest.reportDate, positions: classes.map((row) => {
    const last = latest.positions.find((entry) => entry.id === row.id)!;
    return position(row.id, row.label, last.long, last.short);
  }), history };
}

const tui = createOpenTuiTestHarness();
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  cotBoardCache.reset();
  spies.push(
    spyOn(apiClient, "getCloudCotBoard").mockImplementation(async () => board()),
    spyOn(apiClient, "getCloudCotContract").mockImplementation(async (code: string) => contract(code)),
    spyOn(apiClient, "getCloudHistory").mockRejectedValue(new Error("price history offline in tests")),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  cotBoardCache.reset();
});

const paneRuntime = createTestPluginRuntime();

/** A COT pane created by typing COT with CL active: the template puts the code in params. */
function Harness({ width = 110, height = 28 }: { width?: number; height?: number }) {
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
      <PaneFooterProvider>{() => <CotPane paneId={PANE_INSTANCE_ID} paneType="cot" focused width={width} height={height} />}</PaneFooterProvider>
    </TestPaneProvider>
  );
}

async function settle(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });
  }
}

async function press(name: string) {
  await tui.emitKeypress({ name, sequence: name.length === 1 ? name : undefined }, { trackPropagation: true });
  await settle();
}

test("Esc leaves a detail opened from params for a board that stays navigable", async () => {
  await tui.render(<Harness />, { width: 110, height: 28 });
  await settle();

  let frame = tui.frame();
  expect(frame).toContain("Back");
  expect(frame).toContain("WTI-PHYSICAL");
  expect(frame).not.toContain("MARKET");

  await press("escape");
  frame = tui.frame();
  // The board, not the deep-linked detail again.
  expect(frame).toContain("MARKET");
  expect(frame).toContain("E-MINI S&P 500");
  expect(frame).toContain("GOLD");
  expect(frame).not.toContain("Back");

  // The cursor starts on the deep-linked row and moves; Enter opens the row under it.
  await press("down");
  await press("return");
  frame = tui.frame();
  expect(frame).toContain("Back");
  expect(frame).toContain("GOLD");
  expect(frame).not.toContain("MARKET");

  await press("escape");
  frame = tui.frame();
  expect(frame).toContain("MARKET");
  expect(frame).not.toContain("Back");

  // The board's own keys are live again: / opens the search.
  await press("/");
  await tui.emitKeypress([..."gold"].map((char) => ({ name: char, sequence: char })));
  // The search applies after its input debounce.
  await act(async () => {
    await Bun.sleep(150);
  });
  await settle();
  frame = tui.frame();
  expect(frame).toContain("GOLD");
  expect(frame).not.toContain("E-MINI S&P 500");
});

function useChartedContract() {
  spies.push(
    spyOn(apiClient, "getCloudCotContract").mockImplementation(async (code: string) => charted(code)),
    spyOn(apiClient, "getCloudHistory").mockImplementation(async () => ({ status: "success", data: Array.from({ length: 140 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 4, 5) + index * 86_400_000).toISOString(), open: 60, high: 62, low: 58, close: 60 + index / 10, volume: 1,
    })) }) as never),
  );
}

test("the detail charts the selected class's net and the front price over every class row", async () => {
  useChartedContract();
  // The default floating size's body.
  await tui.render(<Harness width={104} height={28} />, { width: 104, height: 28 });
  await settle();

  let lines = tui.frame().split("\n");
  const legend = lines.findIndex((line) => line.includes("• Noncommercial net +159,000"));
  const header = lines.findIndex((line) => line.includes("CLASS"));
  expect(legend).toBeGreaterThan(0);
  expect(lines[legend]).toContain("+ Front price");
  // The chart sits between the legend and the table, and the table keeps every class.
  expect(header).toBeGreaterThan(legend + 6);
  expect(lines.slice(header + 1).filter((line) => /Noncommercial|Commercial|Nonreportable/.test(line))).toHaveLength(3);

  // The chart follows the selected class.
  await press("down");
  lines = tui.frame().split("\n");
  expect(lines.some((line) => line.includes("• Commercial net -151,000"))).toBe(true);
  expect(lines.some((line) => line.includes("• Noncommercial net"))).toBe(false);
});

test("a short detail keeps the class rows and folds the chart into a strip", async () => {
  useChartedContract();
  await tui.render(<Harness width={60} height={10} />, { width: 60, height: 10 });
  await settle();

  const lines = tui.frame().split("\n");
  expect(lines.some((line) => line.includes("● Noncommercial net") && line.includes("+159,000"))).toBe(true);
  expect(lines.some((line) => line.includes("Front price"))).toBe(false);
  expect(lines.filter((line) => /^ (Noncommercial|Commercial|Nonreportable) /.test(line))).toHaveLength(3);
});
