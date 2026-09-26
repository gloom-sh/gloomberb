import { afterEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { buildHeadlessFunctionReport, renderHeadlessPaneText } from "../../../../cli/pane-functions/headless";
import { PaneFooterBar, PaneFooterProvider } from "../../../../components/layout/pane/footer";
import { takeSavedTextFile, testRender } from "../../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState } from "../../../../state/app/context";
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
let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = null;
});

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

async function mount(financials: TickerFinancials, period: Period = "annual") {
  const initial = createInitialState(paneConfig("/tmp/gloomberb-financials-test"));
  initial.tickers = new Map([[SYMBOL, createTestTicker(SYMBOL)]]);
  initial.financials = new Map([[SYMBOL, financials]]);
  initial.paneState[PANE_ID] = { financialPeriod: period, financialSubTab: "income" };
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    return (
      <AppContext value={{ state, dispatch }}>
        <PaneInstanceProvider paneId={PANE_ID}>
          <PaneFooterProvider>
            {(footer) => (
              <Box width={120} height={28} flexDirection="column">
                <Box height={27}><ResolvedFinancialsTab width={120} focused financials={financials} /></Box>
                <PaneFooterBar footer={footer} focused width={120} />
              </Box>
            )}
          </PaneFooterProvider>
        </PaneInstanceProvider>
      </AppContext>
    );
  }
  setup = await testRender(<Harness />, { width: 120, height: 28 });
  for (let i = 0; i < 3; i++) await act(async () => setup!.renderOnce());
  await act(async () => {
    setup!.mockInput.pressKey("e");
    await setup!.renderOnce();
  });
  await act(async () => setup!.renderOnce());
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
  return setup!.captureCharFrame();
}

test("actual financial table and CSV retain the derived TTM window and known field publication dates", async () => {
  const quarterEnds = ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31"];
  const published = ["2024-05-01", "2024-08-01", "2024-11-01", "2025-02-01"];
  const financials: TickerFinancials = {
    annualStatements: [{ date: "2025-12-31", currency: "USD", totalRevenue: 1000, basicEps: 5, eps: 4.5 }],
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
  expect(csv).toContain("TTM 2024-12-31");
  expect(csv).toContain("Currency,USD");
  expect(frame()).toContain("TTM 2024-12-31");
  expect(frame()).toContain("USD · YoY");
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
  expect(frame()).toContain("USD · YoY");

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
  async function clickPeriod() {
    const rows = frame().split("\n");
    const y = rows.findIndex((line) => line.includes("[p]eriod"));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = rows[y]!.indexOf("[p]eriod");
    await act(async () => {
      await setup!.mockMouse.click(x + 1, y);
      await setup!.renderOnce();
    });
    await act(async () => setup!.renderOnce());
  }

  await clickPeriod();
  const quarterly = await outputs(financials, "quarterly");
  expect(quarterly.csv).toContain("Growth,QoQ");
  expect(quarterly.csv).not.toContain("TTM");
  expect(frame()).toContain("USD · QoQ");
  expect(row(quarterly.result, "eps:1").cells[0]!.value).toBe(0);

  await clickPeriod();
  const annual = await outputs(financials);
  expect(annual.csv).toContain("TTM 2025-12-31");
  expect(annual.csv).toContain("Currency,USD");
  expect(annual.csv).toContain("Growth,YoY");
  expect(frame()).toContain("USD · YoY");
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
    const expectedHeader = reportedCurrency ? "2024-12-31 P USD" : "2024-12-31 P";
    expect(header.currency).toBe(reportedCurrency ?? null);
    expect(result.metadata!.currency).toBeNull();
    expect(row(result, "income:revenue").cells[0]!.growth).toBe(reportedCurrency ? 1 : null);
    expect(row(result, "basicShares:1").cells[0]!.growth).toBe(1);
    expect(csv).toContain(expectedHeader);
    expect(frame()).toContain(expectedHeader);
    expect(text).toContain(reportedCurrency ? "2024-12-31 USD" : "2024-12-31 (provider date)");
    expect(financials.annualStatements[0]!.currency).toBe(reportedCurrency);
  });
}
