import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender, emitKeypress } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneProvider, createTestTicker, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { CorporateActionsData } from "../../../types/financials";
import { Box } from "../../../ui";
import { buildEventDetail, CorporateActionsView, matchEarningsSecFiling, type EventDetailSection } from "./corporate-actions-pane";
import { buildEventRows } from "./event-model";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

async function frame() {
  await act(async () => { await Bun.sleep(1); });
  await act(async () => { await setup!.renderOnce(); });
}

async function render(actions: CorporateActionsData, variant: "corporate-actions" | "earnings-estimates", width = 80) {
  const paneId = `${variant}:TEST`;
  const config = createTestPaneConfig("/tmp/gloom-corporate-actions-pane-test", {
    instanceId: paneId, paneId: variant, binding: { kind: "fixed", symbol: "TEST" },
  });
  const state = createInitialState(config);
  state.focusedPaneId = paneId;
  state.tickers = new Map([["TEST", createTestTicker("TEST", "Test", { exchange: "ASX", currency: "AUD" })]]);
  const provider = createTestDataProvider({
    getCorporateActions: async () => actions,
    getAnalystResearch: async () => ({ symbol: "TEST", recommendations: [], ratings: [], earningsEstimates: [], revenueEstimates: [] }),
  });
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  function Harness() {
    // The selected row is pane state, so the harness needs a reducer.
    const [paneState, setPaneState] = useState<AppState["paneState"]>({});
    state.paneState = paneState;
    const dispatch = (action: AppAction) => setPaneState(appReducer(state, action).paneState);
    return (
      <TestPaneProvider state={state} dispatch={dispatch} paneId={paneId} pluginId="ticker-research" runtime={runtime}>
        <Box width={width} height={24} flexDirection="column">
          <CorporateActionsView focused width={width} height={24} variant={variant} footerPaneId={variant} />
        </Box>
      </TestPaneProvider>
    );
  }
  await act(async () => {
    setup = await testRender(<Harness />, { width, height: 24 });
  });
  for (let index = 0; index < 4; index++) await frame();
}

afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
});

test("opening a fiscal-period row cannot select a same-day pending announcement", async () => {
  await render({ symbol: "TEST", dividends: [], splits: [], earnings: [
    { date: "2026-09-30", dateType: "announcement", epsEstimate: 2.2 },
    { date: "2026-09-30", dateType: "fiscal-period-end", epsActual: 2, epsEstimate: 1.8, currency: "USD" },
  ] }, "earnings-estimates", 120);
  await emitKeypress(setup!, { name: "down" });
  await frame();
  await emitKeypress(setup!, { name: "return" });
  await frame();
  const detail = setup!.captureCharFrame();
  expect(detail).toMatch(/Actual\s+2 USD/);
  expect(detail).toMatch(/Consensus\s+1\.8 USD/);
  expect(detail).not.toMatch(/Consensus\s+2\.2/);
});

test.each(["corporate-actions", "earnings-estimates"] as const)("%s preserves unavailable source status with no visible rows", async (variant) => {
  await render({ symbol: "TEST", earnings: [], splits: [],
    dividends: variant === "earnings-estimates" ? [{ exDate: "2026-09-30", amount: 0.1 }] : [],
    coverage: { dividends: "available", splits: "unavailable", earnings: "unavailable" },
  }, variant);
  expect(setup!.captureCharFrame()).toContain(variant === "earnings-estimates" ? "Unavailable: earnings" : "Unavailable: splits, earnings");
});

/** The detail as text, one line per heading, labelled figure or note. */
function detailText(sections: EventDetailSection[]): string {
  return sections.flatMap((section) => [
    ...(section.title ? [section.title] : []),
    ...section.blocks.map((block) => block.kind === "row" ? `${block.label}: ${block.value}` : block.text),
  ]).join("\n");
}

describe("event detail", () => {
  test("estimate drilldown and JSON retain distinct EPS/revenue inputs, currencies and attribution", () => {
    const eps = { date: "2026-09-30", period: "current quarter", currency: "USD", average: 4.4, low: 4, high: 5, yearAgo: 0, growth: 0, analysts: 12 };
    const revenue = { date: eps.date, period: eps.period, currency: "TWD", average: 1.45e12, low: 1.4e12, high: 1.5e12, yearAgo: 1e12, growth: .45, analysts: 20 };
    const rows = buildEventRows(null, { symbol: "TSM", providerId: "yahoo", fetchedAt: "2026-09-11T12:00:00Z",
      recommendations: [], ratings: [], earningsEstimates: [eps], revenueEstimates: [revenue] }, null, "USD");
    const row = JSON.parse(JSON.stringify(rows[0]));
    expect(row).toMatchObject({ estimateInputs: { eps, revenue }, estimateGrowthMetric: "eps", providerId: "yahoo", fetchedAt: "2026-09-11T12:00:00Z" });
    const detail = detailText(buildEventDetail({ row, secFilingsLoading: false, filing: null, documents: [], documentsLoading: false,
      inlineContent: new Map(), primaryContent: null, primaryContentLoading: false }));
    expect(detail).toContain("EPS consensus\nAverage: 4.4 USD\nLow: 4 USD\nHigh: 5 USD\nPrior year: 0 USD\nGrowth: 0.00%");
    expect(detail).toContain("Revenue consensus\nAverage: 1,450,000,000,000 TWD\nLow: 1,400,000,000,000 TWD\nHigh: 1,500,000,000,000 TWD");
    expect(detail).toContain("Growth: +45.00%");
    expect(detail).toContain("As of: 2026-09-11T12:00:00Z");
    // The pane says what the figures are, never which feed served them.
    expect(detail).not.toContain("yahoo");
  });

  test("matches reported earnings to nearby SEC earnings-release filings", () => {
    const row = buildEventRows({
      symbol: "AAPL",
      dividends: [],
      splits: [],
      earnings: [{ date: "2026-01-30", epsActual: 2.4 }],
    }, null, null, "USD").find((candidate) => candidate.status === "Earnings");
    const filings = [
      {
        accessionNumber: "0000320193-26-000010",
        form: "10-Q",
        filingDate: new Date("2026-02-04T00:00:00Z"),
        cik: "0000320193",
        filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/0000320193-26-000010-index.htm",
      },
      {
        accessionNumber: "0000320193-26-000009",
        form: "8-K",
        filingDate: "2026-01-31T00:00:00.000Z" as unknown as Date,
        items: "2.02,9.01",
        primaryDocDescription: "Results of Operations and Financial Condition",
        cik: "0000320193",
        filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/0000320193-26-000009-index.htm",
      },
    ];

    expect(matchEarningsSecFiling(row, filings)?.accessionNumber).toBe("0000320193-26-000009");
    expect(matchEarningsSecFiling({ ...row!, dateType: "fiscal-period-end" }, filings)).toBeNull();
    const periodRow = { ...row!, dateType: "fiscal-period-end" as const,
      dateEvidence: { accessionNumber: "0000320193-26-000010", filed: "2026-02-04", startDate: "2025-10-01" } };
    expect(matchEarningsSecFiling(periodRow, filings)?.form).toBe("10-Q");
    const detail = detailText(buildEventDetail({ row: periodRow, secFilingsLoading: false,
      filing: filings[0]!, documents: [], documentsLoading: false, inlineContent: new Map(),
      primaryContent: "Fiscal statement content", primaryContentLoading: false }));
    expect(detail).toContain("Fiscal statement content");
  });
});
