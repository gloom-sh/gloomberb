import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { buildTickerReport, renderFundamentalsReport } from "../../../cli/commands/ticker";
import { marketDataCliCommands } from "../../../cli/commands/market";
import { AssetDataRouter } from "../../../sources/provider-router";
import { createTestCliContext } from "../../../test-support/cli-context";
import { createTestHeadlessContext } from "../../../test-support/headless";
import { extractFundamentalSeries } from "../../../time-series/fundamentals";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneLoadArgs } from "../../../types/plugin";
import { resetEarningsCalendarPersistence } from "../earnings/data/cache";
import { createEarningsHeadless } from "../earnings/headless";
import { projectPeBand } from "../pe-band/model";
import { createEarningsEstimatesHeadless } from "../research/headless";
import { AGREEMENT_NOW, agreementEarningsSources, createAgreementProvider } from "./earnings-agreement.test-data";

/**
 * One trailing EPS, one P/E and one consensus per company in every function
 * that shows them: `ticker`, `valuation`, EE, PEB and GE price the last four
 * filed quarters, and ERN (one ticker, a ticker list, a day), EE and `events`
 * read a report gone by from the stored board, not the next quarter's
 * consensus the per-ticker calendar has rolled to.
 */

const COMPANIES = {
  // A cent apart from a fiscal-year reading when the fourth quarter's EPS is the results release's.
  META: { eps: 29.33, epsText: "$29.33", pe: 630.56 / 29.33, peText: "21.50",
    report: { date: "2026-10-21", dateStatus: "reported", epsEstimate: 6.52, epsAnalysts: 6, epsActual: 7.4, epsBasis: "adjusted" } },
  // Gloom Cloud's own figure is 1.13 and 175.96.
  PLTR: { eps: 1.17, epsText: "$1.17", pe: 198.84 / 1.17, peText: "169.95",
    report: { date: "2026-11-02", dateStatus: "confirmed", epsEstimate: 0.41097, epsAnalysts: 24, epsActual: null, epsBasis: null } },
} as const;
type Symbol = keyof typeof COMPANIES;
const SYMBOLS = Object.keys(COMPANIES) as Symbol[];

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u00a0/g, " ").replace(/ {2,}/g, " ");
const consensus = (row: Record<string, unknown> | undefined) => row && {
  date: row.date, dateStatus: row.dateStatus, epsEstimate: row.epsEstimate, epsAnalysts: row.epsAnalysts ?? null,
  epsActual: row.epsActual ?? null, epsBasis: row.epsBasis === "unknown" || row.epsBasis == null ? null : row.epsBasis,
};
const expected = (symbol: Symbol) => ({ ...COMPANIES[symbol].report, epsBasis: COMPANIES[symbol].report.epsBasis });

let router: AssetDataRouter;
beforeAll(() => {
  setSystemTime(AGREEMENT_NOW);
  resetEarningsCalendarPersistence();
  router = new AssetDataRouter(createAgreementProvider());
});
afterAll(() => {
  setSystemTime();
  resetEarningsCalendarPersistence();
});

const config = createDefaultConfig("/tmp/gloom-earnings-agreement-unused");
const args = (symbols: string[], options: HeadlessPaneLoadArgs["options"] = {}): HeadlessPaneLoadArgs => ({
  rawArgument: symbols.join(" "), argument: symbols.length === 1 ? symbols[0]! : symbols, symbols, options,
});

describe.each(SYMBOLS)("%s", (symbol) => {
  const company = COMPANIES[symbol];

  test("ticker, valuation, EE, PEB and GE price the same trailing EPS", async () => {
    const financials = await router.getTickerFinancials(symbol, "");
    expect(financials.fundamentals).toMatchObject({ trailingEpsSource: "filed-quarters" });

    const ticker = plain(await buildTickerReport({ symbol, tickerFile: null, financials, config, toBase: async (value) => value }));
    const valuation = plain(renderFundamentalsReport({ ...financials, symbol }, "valuation"));
    for (const report of [ticker, valuation]) {
      expect(report).toContain(`EPS (TTM) ${company.epsText}`);
      expect(report).toContain(`P/E (TTM) ${company.peText}`);
    }

    const ee = await createEarningsEstimatesHeadless().load(args([symbol]), createTestHeadlessContext({ marketData: router }));
    const ttm = ee.rows.find((row) => row.status === "TTM");
    expect(ttm?.annualEps).toBeCloseTo(company.eps, 6);
    expect(ttm?.detail).toBe("GAAP diluted");

    const extended = await router.getTickerFinancials(symbol, "", { statementHistory: "extended" });
    const band = projectPeBand(extended, extended.priceHistory, { symbol, lookbackYears: 0, now: AGREEMENT_NOW.getTime() });
    expect(band.current?.eps).toBeCloseTo(company.eps, 6);
    expect(band.current?.pe).toBeCloseTo(company.pe, 6);

    const ge = extractFundamentalSeries(extended, {
      kind: "security", instrument: { symbol, exchange: "NASDAQ" }, fieldId: "valuation.trailingPE", period: "daily", timestampMode: "available-at",
    });
    expect(ge.at(-1)?.date.toISOString().slice(0, 10)).toBe("2026-10-26");
    expect(ge.at(-1)?.value).toBeCloseTo(company.pe, 6);
  });

  test("ERN for one ticker, a ticker list and the report's day, EE and events show one consensus for the report", async () => {
    const ern = createEarningsHeadless(agreementEarningsSources);
    const context = createTestHeadlessContext({ marketData: router });
    const single = await ern.load(args([symbol]), context);
    const list = await ern.load(args(["META", "PLTR"]), context);
    const day = await ern.load(args([], { date: company.report.date }), context);
    const onDay = day.rows.find((row) => row.symbol === symbol);
    const onList = list.rows.find((row) => row.symbol === symbol);
    // The board's cap for the report is the same whether the day or the ticker list is asked for.
    expect(onList?.marketCap).toBe(onDay?.marketCap);
    expect(onList?.marketCap).not.toBeNull();

    const ee = await createEarningsEstimatesHeadless().load(args([symbol]), context);
    const events = createTestCliContext({ dataProvider: router });
    await marketDataCliCommands.find((command) => command.name === "events")!.execute([`${symbol}:NASDAQ`], events.context);
    const { result, options } = events.printed[0]!;
    const eventRows = options!.rows!(result.data) as Array<Record<string, unknown>>;

    const at = (rows: ReadonlyArray<Record<string, unknown>>) => rows.find((row) => row.date === company.report.date && (row.status ?? row.type) !== "Q Est");
    for (const row of [single.rows.find((candidate) => candidate.date === company.report.date), onList, onDay, at(ee.rows), at(eventRows)]) {
      expect(consensus(row)).toEqual(expected(symbol));
    }
  });
});

test("a quarter whose basis Gloom Cloud cannot tell reads unknown in events as in ERN", async () => {
  const ern = await createEarningsHeadless(agreementEarningsSources).load(args(["PLTR"]), createTestHeadlessContext({ marketData: router }));
  const events = createTestCliContext({ dataProvider: router });
  await marketDataCliCommands.find((command) => command.name === "events")!.execute(["PLTR:NASDAQ"], events.context);
  const { result, options } = events.printed[0]!;
  const row = (options!.rows!(result.data) as Array<Record<string, unknown>>).find((candidate) => candidate.date === "2025-05-05");
  expect(ern.rows.find((candidate) => candidate.date === "2025-05-05")?.epsBasis).toBe("unknown");
  expect(row).toMatchObject({ epsBasis: "unknown", detail: "eps $0.04, unknown, -0.04 vs est (Mar 2025)" });
});
