import { expect, test } from "bun:test";
import { act, useReducer } from "react";
import { buildHeadlessFunctionReport, renderHeadlessPaneText } from "../../../../cli/pane-functions/headless";
import { PaneFooterBar, PaneFooterProvider } from "../../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, takeSavedTextFile } from "../../../../renderers/opentui/test-utils";
import { mapCloudFinancials } from "../../../../sources/gloomberb-cloud/normalizers";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState } from "../../../../state/app/context";
import { createStaticAppStore } from "../../../../test-support/app-store";
import { exportPaneTable } from "../../../../state/pane-table-export-registry";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestPaneConfig, createTestTicker } from "../../../../test-support/pane";
import type { TickerFinancials } from "../../../../types/financials";
import type { HeadlessRowsResult } from "../../../../types/headless";
import { Box } from "../../../../ui";
import { financialStatementsHeadless } from "../headless";
import { ResolvedFinancialsTab } from "./tab";

type Period = "annual" | "quarterly";

interface StatementCell {
  value: number | null;
  growth: number | null;
}

interface StatementRow {
  id: string;
  cells: StatementCell[];
  [date: string]: unknown;
}

interface StatementColumn {
  date: string;
  currency: string | null;
  aggregation?: { sourcePeriods: Array<{ date: string }> };
}

const PANE_ID = "financials:test";
const SYMBOL = "ACME";
const tui = createOpenTuiTestHarness();

function paneConfig(dataDir: string) {
  return createTestPaneConfig(dataDir, {
    instanceId: PANE_ID,
    paneId: "financial-analysis",
    binding: { kind: "fixed", symbol: SYMBOL },
  });
}

function cli(financials: TickerFinancials, period: Period) {
  const resolved = {
    token: "FA",
    label: "Financial Analysis",
    headless: financialStatementsHeadless,
    options: { period, statement: "income" },
    instance: { settings: {} },
    capability: { id: "financial-statements" },
  };
  const context = {
    config: paneConfig("/tmp/gloomberb-financials-cli-test"),
    dataProvider: createTestDataProvider({ getTickerFinancials: async () => financials }),
    store: { loadTicker: async () => null },
  };
  return buildHeadlessFunctionReport(resolved as never, context as never, SYMBOL);
}

async function mount(financials: TickerFinancials, period: Period = "annual", width = 120) {
  const initial = createInitialState(paneConfig("/tmp/gloomberb-financials-test"));
  initial.tickers = new Map([[SYMBOL, createTestTicker(SYMBOL)]]);
  initial.financials = new Map([[SYMBOL, financials]]);
  initial.paneState[PANE_ID] = { financialPeriod: period, financialSubTab: "income" };
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    return (
      <AppContext value={createStaticAppStore(state, dispatch)}>
        <PaneInstanceProvider paneId={PANE_ID}>
          <PaneFooterProvider>
            {(footer) => (
              <Box width={width} height={28} flexDirection="column">
                <Box height={27}><ResolvedFinancialsTab width={width} focused financials={financials} /></Box>
                <PaneFooterBar footer={footer} focused width={width} />
              </Box>
            )}
          </PaneFooterProvider>
        </PaneInstanceProvider>
      </AppContext>
    );
  }
  await tui.render(<Harness />, { width, height: 28 });
  await tui.renderFrames(3);
  await act(async () => {
    tui.setup().mockInput.pressKey("e");
    await tui.setup().renderOnce();
  });
  await act(async () => tui.setup().renderOnce());
}

/** The pane's CSV export plus the headless report for the same financials. */
async function outputs(financials: TickerFinancials, period: Period = "annual") {
  await exportPaneTable(PANE_ID, "financials.csv");
  const csv = takeSavedTextFile()!.text;
  const args = { symbols: [SYMBOL], argument: [SYMBOL], rawArgument: SYMBOL, options: { period, statement: "income" } };
  const result = await financialStatementsHeadless.load(args, {
    marketData: createTestDataProvider({ getTickerFinancials: async () => financials }),
  } as never) as HeadlessRowsResult;
  const text = renderHeadlessPaneText(financialStatementsHeadless, result, args, "Financials");
  return { result, text, csv };
}

function row(result: HeadlessRowsResult, id: string): StatementRow {
  return result.rows.find((entry) => entry.id === id) as StatementRow;
}

function columns(result: HeadlessRowsResult): StatementColumn[] {
  return result.metadata!.columns as StatementColumn[];
}

function frame() {
  return tui.frame();
}

async function clickPeriod() {
  const rows = frame().split("\n");
  const y = rows.findIndex((line) => line.includes("[p]eriod"));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = rows[y]!.indexOf("[p]eriod");
  await act(async () => {
    await tui.setup().mockMouse.click(x + 1, y);
    await tui.setup().renderOnce();
  });
  await act(async () => tui.setup().renderOnce());
}

const PREDECESSOR = { registrant: "0002128626", entity: "corteva-consolidated", basis: "predecessor" as const, label: "Corteva consolidated (accounting predecessor)" };

/** A spun-off listing's quarter, filed in its predecessor's accounts when scoped. */
function predecessorQuarter(scoped: boolean, review?: "pending"): TickerFinancials {
  const scope = scoped ? { statementScope: PREDECESSOR } : {};
  return {
    annualStatements: [],
    quarterlyStatements: [{ ...scope, date: "2026-09-30", currency: "USD", totalRevenue: 2458e6 }],
    priceHistory: [],
    ...scope,
    ...(review ? { statementReview: { status: review, reviewedThrough: "2026-11-01" } } : {}),
  };
}

/** The frame's text without its spacing, so a note wraps wherever the width breaks it. */
const unspaced = (text: string) => text.replace(/[\s│┌┐└┘─]/g, "");
const frameText = () => unspaced(frame());

async function pressSection(key: string) {
  await act(async () => {
    tui.setup().mockInput.pressKey(key);
    await tui.setup().renderOnce();
  });
  await act(async () => tui.setup().renderOnce());
}

// The query bar's meta gives way first, so the basis is said under it, whole at any width.
for (const width of [52, 160]) {
  for (const review of [undefined, "pending"] as const) {
    test(`a scoped series says its basis whole on statements and ratios at ${width} columns${review ? " with a filing under review" : ""}`, async () => {
      const data = predecessorQuarter(true, review);
      const note = `Statement basis: ${PREDECESSOR.label}.${review ? " New filing under review." : ""}`;
      await mount(data, "quarterly", width);
      expect(frameText()).toContain(unspaced(note));
      const statements = await outputs(data, "quarterly");
      expect(row(statements.result, "income:revenue").cells[0]?.value).toBe(2458e6);
      expect(statements.csv).toContain(`\nAs of,2026-09-30\nStatement basis,${PREDECESSOR.label}\nCurrency,USD\nUnit,bn\nGrowth,QoQ`);

      await pressSection("4");
      expect(frame()).toContain("Profitability");
      expect(frameText()).toContain(unspaced(note));
      await exportPaneTable(PANE_ID, "financials.csv");
      expect(takeSavedTextFile()!.text).toContain(`\nAs of,2026-09-30\nStatement basis,${PREDECESSOR.label}\nCurrency,USD`);
    });
  }
}

test("statements with no scope add no basis note and keep a filing under review in the query bar", async () => {
  for (const width of [52, 160]) {
    await mount(predecessorQuarter(false), "quarterly", width);
    expect(frameText()).not.toContain("Statementbasis");
    const { csv } = await outputs(predecessorQuarter(false), "quarterly");
    expect(csv).not.toContain("Statement basis");
  }
  await mount(predecessorQuarter(false, "pending"), "quarterly", 160);
  expect(frame().split("\n")[0]).toContain("New filing under review · QoQ");
  expect(frameText()).not.toContain("Statementbasis");
});

test("actual financial table and CSV retain the derived TTM window and known field publication dates", async () => {
  const quarterEnds = ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31"];
  const published = ["2024-05-01", "2024-08-01", "2024-11-01", "2025-02-01"];
  const financials: TickerFinancials = {
    // The year before the quarters: a TTM ending before the latest year would be no column.
    annualStatements: [{ date: "2023-12-31", currency: "USD", totalRevenue: 1000, basicEps: 5, eps: 4.5 }],
    quarterlyStatements: quarterEnds.map((date, i) => ({
      date,
      currency: "USD",
      totalRevenue: 100,
      netIncome: 0,
      basicEps: 0,
      eps: 0,
      availableAt: published[i],
      fieldAvailability: { totalRevenue: published[i]! },
    })),
    priceHistory: [],
  };
  await mount(financials);
  const { result, csv } = await outputs(financials);
  expect(columns(result)[0]).toMatchObject({
    date: "TTM",
    availableAt: null,
    fieldAvailability: { totalRevenue: "2025-02-01" },
    aggregation: { kind: "trailing-four-quarters", periodEnd: "2024-12-31" },
  });
  expect(columns(result)[0]!.aggregation!.sourcePeriods.map((period) => period.date)).toEqual(quarterEnds);
  // A column is headed by its fiscal period; the day it ends is the first row, in the pane and in its CSV.
  expect(csv).toContain("USD k,TTM Q4 FY24,FY2023\nPeriod end,2024-12-31,2023-12-31\n");
  expect(csv).toContain("Currency,USD");
  expect(frame()).toMatch(/USD K\s+TTM Q4 FY24\s+FY2023\s*\n\s+Period end\s+31 Dec 2024\s+31 Dec 2023\s*\n/);
  expect(frame()).toMatch(/^ {2}USD K\s/m);
  expect(row(result, "income:revenue").TTM).toBe(400);
});

test("actual financial table exports preserve count growth independently of uncertain monetary comparisons", async () => {
  const financials: TickerFinancials = {
    annualStatements: [
      { date: "2023-12-31", totalRevenue: 100, basicShares: 10, eps: 1 },
      { date: "2024-12-31", currency: "JPY", totalRevenue: 200, basicShares: 20, eps: 2 },
      { date: "2025-12-31", currency: "USD", totalRevenue: 300, basicShares: 30, eps: 3 },
    ],
    quarterlyStatements: [],
    priceHistory: [],
  };
  await mount(financials);
  const { result } = await outputs(financials);
  const revenue = row(result, "income:revenue");
  const shares = row(result, "basicShares:1");
  expect(revenue.cells[1]!.growth).toBeNull();
  expect(revenue.cells[0]!.growth).toBeNull();
  expect(shares.cells[0]!.growth).toBe(0.5);
  expect(shares.cells[1]!.growth).toBe(1);
});

test("explicit quarterly headless report fails honestly while interactive tabs identify available annual coverage", async () => {
  const financials: TickerFinancials = {
    annualStatements: [
      { date: "2024-12-31", currency: "USD", totalRevenue: 100 },
      { date: "2025-12-31", currency: "USD", totalRevenue: 200 },
    ],
    quarterlyStatements: [],
    priceHistory: [],
  };
  await mount(financials, "quarterly");
  const { result, text } = await outputs(financials, "quarterly");
  expect(result.metadata!.period).toBe("quarterly");
  expect(text).toContain(`${SYMBOL} | quarterly | income`);
  expect(result.rows).toEqual([]);
  expect(result.unavailableSymbols).toEqual([SYMBOL]);
  expect(text).toContain("No quarterly financial statement coverage");
  expect(frame()).toMatch(/FY2025\s+FY2024\s*\n\s+Period end\s+31 Dec 2025\s+31 Dec 2024/);

  const unavailable = await cli(financials, "quarterly");
  expect(unavailable.data).toMatchObject({ complete: false, empty: true, unavailableSymbols: [SYMBOL] });
  const annual = await cli(financials, "annual");
  expect(annual.data).toMatchObject({ complete: true, empty: false });
  expect(annual.text).toContain("200");

  const quarterlyOnly: TickerFinancials = {
    ...financials,
    annualStatements: [],
    quarterlyStatements: [{ date: "2026-03-31", currency: "USD", totalRevenue: 50 }],
  };
  expect((await cli(quarterlyOnly, "annual")).data).toMatchObject({ complete: false, empty: true });
  expect((await cli(quarterlyOnly, "quarterly")).data).toMatchObject({ complete: true, empty: false });
});

test("mouse period changes keep active CSV and quarterly values aligned, including zero EPS", async () => {
  const financials: TickerFinancials = {
    financialCurrency: "USD",
    annualStatements: [{ date: "2025-12-31", currency: "USD", totalRevenue: 400, eps: 0 }],
    quarterlyStatements: ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"]
      .map((date) => ({ date, currency: "USD", totalRevenue: 100, eps: 0 })),
    priceHistory: [],
  };
  await mount(financials);
  await clickPeriod();
  const quarterly = await outputs(financials, "quarterly");
  expect(quarterly.csv).toContain("Growth,QoQ");
  expect(quarterly.csv).not.toContain("TTM");
  expect(frame()).toMatch(/Q4 FY25\s+Q3 FY25\s+Q2 FY25\s+Q1 FY25\s*\n\s+Period end\s+31 Dec 2025\s+30 Sep 2025\s+30 Jun 2025\s+31 Mar 2025/);
  expect(row(quarterly.result, "eps:1").cells[0]!.value).toBe(0);

  await clickPeriod();
  const annual = await outputs(financials);
  // The four 2025 quarters are FY2025, so the year stands alone.
  expect(annual.csv).not.toContain("TTM");
  expect(annual.csv).toContain("FY2025");
  expect(annual.csv).toContain("Currency,USD");
  expect(annual.csv).toContain("Growth,YoY");
  expect(frame()).toMatch(/FY2025\s*\n\s+Period end\s+31 Dec 2025/);
});

test("the exchange view exports source-linked year-to-date results apart from the standalone quarter", async () => {
  const url = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci";
  await mount({
    financialCurrency: "TWD",
    annualStatements: [],
    quarterlyStatements: [{ date: "2026-09-30", currency: "TWD", totalRevenue: 1_562_173_000, eps: 6.12 }],
    priceHistory: [],
    taiwanExchangeStatements: [{
      kind: "income", periodEnd: "2026-09-30", months: 9, currency: "TWD",
      figures: [{ label: "Revenue", sourceLabel: "營業收入", value: 3_687_740_000 }],
      source: { venue: "TPEX", url, snapshotDate: "2026-11-26", observedAt: "2026-11-26T21:39:20Z" },
    }],
  }, "quarterly");
  expect(frame()).not.toContain("3,687,740,000");
  await clickPeriod();
  expect(frame()).toContain("9 months ended 30 Sep 2026");
  expect(frame()).toContain("TPEx export 26 Nov 2026");
  expect(frame()).toContain("3,687,740,000");
  await exportPaneTable(PANE_ID, "taiwan.csv");
  const csv = takeSavedTextFile()!.text;
  expect(csv).toContain(`Source,${url}`);
  expect(csv).toContain("Revenue,3687740000");
  await clickPeriod();
  expect(frame()).not.toContain("3,687,740,000");
});

test("the issuer filing stays with its fiscal period through normalization, FA and export", async () => {
  const url = "https://mopsov.twse.com.tw/server-java/t164sb01?step=3&SYEAR=2026&file_name=tifrs-fr1-m1-ci-cr-2330-2026Q3.html";
  const filing = {
    source: "mops", kind: "quarterly_results", title: "2026 Q3 financial report", url,
    periodEnd: "2026-09-30", periodMonths: 9,
    publishedAt: "2026-11-12T00:00:00Z", fetchedAt: "2026-11-12T00:10:00Z",
  } as const;
  const financials = mapCloudFinancials({
    annualStatements: [], priceHistory: [],
    quarterlyStatements: [
      { date: "2026-06-30", currency: "TWD", totalRevenue: 1_000_000_000 },
      { date: filing.periodEnd, currency: "TWD", netIncome: 400_000_000,
        filledFrom: { source: "results", documents: [filing], fields: ["netIncome"],
          lines: { netIncome: { document: 0, page: null } } } },
    ],
    statementFilings: [
      { ...filing, periodMonths: 12, url: "https://mopsov.twse.com.tw/annual" },
      filing,
    ],
  });
  await mount(financials, "quarterly");
  const { result, csv } = await outputs(financials, "quarterly");
  expect(columns(result)[0]).toMatchObject({ date: filing.periodEnd, issuerFiling: filing });
  expect(csv).toContain(`Issuer filing for ${filing.periodEnd},${url}`);
  expect(csv).toContain("Period end,2026-09-30");
});

for (const reportedCurrency of [undefined, "USD"]) {
  test(`historical headers and exports retain ${reportedCurrency ?? "unknown"} units across an unrelated reporting-currency change`, async () => {
    const financials: TickerFinancials = {
      financialCurrency: "USD",
      annualStatements: [
        { date: "2024-12-31", currency: reportedCurrency, totalRevenue: 100, basicShares: 10 },
        { date: "2025-12-31", currency: "USD", totalRevenue: 200, basicShares: 20 },
      ],
      quarterlyStatements: [{ date: "2023-09-30", currency: "JPY", totalRevenue: 50 }],
      priceHistory: [],
    };
    await mount(financials);
    const { result, csv, text } = await outputs(financials);
    const header = columns(result).find((column) => column.date === "2024-12-31")!;
    // Mixed reporting currencies: each column names its own.
    const expectedHeader = reportedCurrency ? "FY2024 USD" : "FY2024";
    expect(header.currency).toBe(reportedCurrency ?? null);
    expect(result.metadata!.currency).toBeNull();
    expect(row(result, "income:revenue").cells[0]!.growth).toBe(reportedCurrency ? 1 : null);
    expect(row(result, "basicShares:1").cells[0]!.growth).toBe(1);
    expect(csv).toContain(`Metric,FY2025 USD,${expectedHeader}\nPeriod end,2025-12-31,2024-12-31\n`);
    expect(frame()).toMatch(reportedCurrency ? /FY2025 USD\s+FY2024 USD\s*\n/ : /FY2025 USD\s+FY2024\s*\n/);
    expect(frame()).toMatch(/Period end\s+31 Dec 2025\s+31 Dec 2024/);
    expect(text).toContain(reportedCurrency ? "2024-12-31 USD" : "2024-12-31 (provider date)");
    expect(financials.annualStatements[0]!.currency).toBe(reportedCurrency);
  });
}

/** The headless FA report for these financials; `extended` is what GF's extended history holds. */
async function statementsReport(period: Period, financials: TickerFinancials, extended: Partial<TickerFinancials> = {}) {
  const args = { symbols: [SYMBOL], argument: [SYMBOL], rawArgument: SYMBOL, options: { period, statement: "income" } };
  const marketData = createTestDataProvider({
    getTickerFinancials: async (_symbol, _exchange, context) => context?.statementHistory === "extended" ? { ...financials, ...extended } : financials,
  });
  const result = await financialStatementsHeadless.load(args, { marketData } as never) as HeadlessRowsResult;
  return { result, text: renderHeadlessPaneText(financialStatementsHeadless, result, args, "Financials") };
}

test("a quarterly report says its growth is vs prior quarter, and a share count of zero or in the wrong unit is missing", async () => {
  // IAG's Q3 2025 averages: 4,642 (millions read as shares) and none at all for Q4.
  const financials: TickerFinancials = {
    annualStatements: [{ date: "2024-12-31", totalRevenue: 32_000, dilutedShares: 4.9e9 }],
    quarterlyStatements: [
      { date: "2025-06-30", totalRevenue: 8_860, dilutedShares: 4.67e9 },
      { date: "2025-09-30", totalRevenue: 9_330, dilutedShares: 4_642 },
      { date: "2025-12-31", totalRevenue: 7_980, dilutedShares: 0 },
      { date: "2026-03-31", totalRevenue: 7_180, dilutedShares: 4.96e9 },
    ],
    priceHistory: [],
  };
  const { result, text } = await statementsReport("quarterly", financials);
  expect(text).toContain("Growth: QoQ.");
  const shares = row(result, "dilutedShares:1").cells;
  expect(shares.map((cell) => cell.value)).toEqual([4.96e9, null, null, 4.67e9]);
  // No fall of 100% into a missing count, and no rise out of one.
  expect(shares.map((cell) => cell.growth)).toEqual([null, null, null, null]);
  expect((await statementsReport("annual", financials)).text).not.toContain("vs prior quarter");
});

test("a statements report points to GF only when GF holds older periods, and a half-yearly reporter says so", async () => {
  const years = [{ date: "2024-06-30", totalRevenue: 22_000 }, { date: "2025-06-30", totalRevenue: 23_800 }];
  const financials: TickerFinancials = {
    annualStatements: years,
    quarterlyStatements: [{ date: "2025-12-31", totalAssets: 50_000 }, { date: "2026-06-30", totalAssets: 52_000 }],
    priceHistory: [],
  };
  // GF reads the same years: no pointer to it.
  const same = await statementsReport("annual", financials, { annualStatements: [{ date: "2015-06-30", totalAssets: 9_000 }, ...years] });
  expect(same.text).toContain("annual history from 2024; no earlier revenue in GF's latest 40 periods");
  expect(same.text).not.toContain("fn GF");
  // GF goes back to 2015: the pointer stays.
  const deeper = await statementsReport("annual", financials, { annualStatements: [{ date: "2015-06-30", totalRevenue: 15_000 }, ...years] });
  expect(deeper.text).toContain(`earlier revenue: gloom fn GF ${SYMBOL} --period annual --periods 40`);
  // Statements half a year apart, with no income line: the reason, and the years to read instead.
  const quarterly = await statementsReport("quarterly", financials);
  expect(quarterly.result.rows).toEqual([]);
  expect(quarterly.result.errors).toEqual([`${SYMBOL} reports half-yearly, not quarterly. For its years: gloom fn FA ${SYMBOL} --period annual`]);
  // A company with a quarter and no full year reported yet: the annual report names its quarters.
  const firstQuarter = await statementsReport("annual", { annualStatements: [], quarterlyStatements: [{ date: "2026-05-31", netIncome: -671_000 }], priceHistory: [] });
  expect(firstQuarter.result.errors).toEqual([`${SYMBOL}: No annual financial statement coverage. For its quarters: gloom fn FA ${SYMBOL} --period quarterly`]);
});
