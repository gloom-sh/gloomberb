import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import type { EstimateObservation, EstimatePeriod, EstimateRevisionsPayload } from "../../../api-client/estimate-revisions";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { estimateRevisionsCache } from "./client";
import { EstimateRevisionsPane } from "./pane";

// Twelve weekly recorded consensus reads, 1.60 rising a cent a week, and two lookbacks.
const recorded: EstimateObservation[] = Array.from({ length: 12 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 6, 1) + index * 7 * 86_400_000).toISOString().slice(0, 10);
  const average = Number((1.6 + index * 0.01).toFixed(2));
  return { date, recordedAt: `${date}T21:00:00Z`, average, low: 1.5, high: 1.8, analysts: 28, range: 0.3, relativeRange: 0.18, source: "gloom" };
});
const lookbacks: EstimateObservation[] = [["2026-07-10", 1.58], ["2026-08-09", 1.62]].map(([date, average]) => ({
  date: date as string, recordedAt: "2026-09-20T21:00:00Z", average: average as number,
  low: null, high: null, analysts: null, range: null, relativeRange: null, source: "gloom-eps-trend" as const,
}));
const latest = recorded.at(-1)!;
const stats = { percentile: null, samples: 0, min: null, max: null, mean: null };
const period = {
  id: "quarterly:2026-09-30:USD", frequency: "quarterly", periodEnd: "2026-09-30", currency: "USD", label: "current quarter",
  current: { ...latest, growth: null }, revenue: null, recorded, lookbacks,
  percentile: { ...stats, window: "1Y", firstDate: recorded[0]!.date, lastDate: latest.date },
  dispersionPercentile: stats,
  change: { value: 0.11, percent: 6.88, fromDate: recorded[0]!.date, toDate: latest.date },
  breadth: [{ days: 30, up: 6, down: 1, net: 5, ratio: 0.86, asOf: latest.date, percentile: null }],
} as unknown as EstimatePeriod;
const source = { status: "available" as const, fetchedAt: "2026-09-22T12:00:00Z", stale: false, reason: null };
const payload = {
  symbol: "AAPL", exchange: "NASDAQ", generatedAt: source.fetchedAt, status: "available",
  sources: { consensus: source, history: source, reported: source, guidance: source },
  periods: [period], surprises: [], guidance: null, gaps: [],
  historyCoverage: { since: "2025-09-22", until: "2026-09-22", truncated: false, excludedRows: 0, recordedDays: 12, lookbackRows: 2 },
} as unknown as EstimateRevisionsPayload;
const estimatesSpy = spyOn(apiClient, "getCloudEstimateRevisions").mockResolvedValue(payload);
afterAll(() => estimatesSpy.mockRestore());

const tui = createOpenTuiTestHarness();
afterEach(() => {
  estimateRevisionsCache.reset();
});

async function settle(delayMs = 5) {
  for (let index = 0; index < 6; index += 1) await act(async () => { await Bun.sleep(delayMs); await tui.setup().renderOnce(); });
}

/** The pane with the quarter's detail open, as a reload restores it. */
async function renderDetail(width: number, height: number): Promise<string[]> {
  const id = "estimate-revisions:AAPL";
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-estimates-test", {
    instanceId: id, paneId: "estimate-revisions", binding: { kind: "fixed", symbol: "AAPL" },
  }));
  state.tickers.set("AAPL", createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ" }));
  state.paneState[id] = { pluginState: { "estimate-revisions": { "estimates:open": period.id } } } as never;
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [paneState, setPaneState] = useState(state.paneState);
    state.paneState = paneState;
    return (
      <TestPaneFrame width={width} height={height + 1} state={state} paneId={id} pluginId="estimate-revisions" runtime={runtime}
        dispatch={(action) => setPaneState(appReducer(state, action).paneState)}>
        {(body) => <EstimateRevisionsPane paneId={id} paneType="estimate-revisions" width={body.width} height={body.height} focused />}
      </TestPaneFrame>
    );
  }
  await act(async () => { await tui.render(<Harness />, { width, height: height + 1 }); });
  await settle();
  return tui.frame().split("\n");
}

test("the period detail charts recorded and lookback EPS over its observations, the selected one as the cursor", async () => {
  const lines = await renderDetail(102, 28);
  expect(lines[1]).toContain("← Back");
  expect(lines[2]).toMatch(/EPS\s+1\.71 USD/);
  // The legend names each line as the SOURCE column does, at the latest observation.
  expect(lines.some((line) => /● Recorded 1\.71 ● Reported lookback 1\.62/.test(line))).toBe(true);
  const header = lines.findIndex((line) => line.includes("OBSERVED"));
  expect(lines[header + 1]).toMatch(/2026-09-16\s+1\.71/);
  // The detail fills the body under the stack bar, down to the footer.
  expect(lines[27]).toMatch(/\d{4}-\d{2}-\d{2}/);

  await tui.emitKeypress({ name: "down" });
  await settle(40);
  expect(tui.frame()).toContain("● Recorded 1.7 ");
  await tui.emitKeypress({ name: "left" });
  await settle(20);
  expect(tui.frame()).toContain("● Recorded 1.69 ");
});

test("a short detail keeps the observations and draws the chart as a strip", async () => {
  const lines = await renderDetail(60, 11);
  const header = lines.findIndex((line) => line.includes("OBSERVED"));
  // The EPS figure above already reads 1.71, so the strip does not repeat it.
  expect(lines[header - 2]).toContain("EPS  1.71 USD");
  expect(lines[header - 1]).toMatch(/^ ● Recorded [⠀-⣿]+\s*$/);
  expect(lines.slice(header + 1).filter((line) => /\d{4}-\d{2}-\d{2}/.test(line)).length).toBeGreaterThanOrEqual(4);
});
