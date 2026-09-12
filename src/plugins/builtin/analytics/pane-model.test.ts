import { expect, test } from "bun:test";
import type { ResolvedPortfolioAccountState } from "../portfolio-list/summary";
import type { PortfolioSummaryTotals } from "../portfolio-list/metrics";
import type { TickerRecord } from "../../../types/ticker";
import type { PricePoint } from "../../../types/financials";
import { buildChartKey } from "../../../market-data/selectors";
import { buildAnalyticsRiskRows, buildAnalyticsSummaryRows, buildBenchmarkReturnSeries, buildPortfolioChartTargets, buildPortfolioReturnSeries } from "./pane-model";

function riskTicker(symbol: string): TickerRecord {
  return { metadata: { ticker: symbol, exchange: "NYSE", currency: "USD", name: symbol,
    positions: [{ portfolio: "main", shares: 10, avgCost: 100, markPrice: 120, broker: "manual", currency: "USD" }],
    portfolios: ["main"], watchlists: [], custom: {}, tags: [],
  } };
}

function riskHistory(): PricePoint[] {
  return Array.from({ length: 21 }, (_, index) => ({ date: new Date(Date.UTC(2026, 7, 21 + index)), close: 740 + index + index % 2 }));
}

// Original reported SPY contradiction captured during the research audit.
const rejectedSpy = { date: new Date("2026-09-10"), open: 764.08, high: 758.555, low: 757.57, close: 758.15, volume: 3461376 };

test("a rejected benchmark suppresses beta while the independent basket Sharpe remains available", () => {
  const request = buildPortfolioChartTargets([riskTicker("SPY")])[0]!.request;
  const history = [...riskHistory().slice(0, -1), rejectedSpy];
  const entries = new Map([[buildChartKey(request), { data: history }]]);
  const result = buildBenchmarkReturnSeries(request, entries);
  expect(result.returns).toEqual([]);
  expect(result.integrity?.sourcePoints[0]).toMatchObject({ open: 764.08, high: 758.555, close: 758.15 });
  const rows = buildAnalyticsRiskRows({ sharpe: 1.75, beta: 1.2, benchmarkIntegrity: result.integrity });
  expect(rows[0]?.value).toBe("1.75");
  expect(rows[1]).toMatchObject({ value: "—", detail: "SPY benchmark: inconsistent OHLC history" });
  entries.set(buildChartKey(request), { data: riskHistory() });
  expect(buildBenchmarkReturnSeries(request, entries)).toMatchObject({ integrity: null });
  expect(buildBenchmarkReturnSeries(request, entries).returns).toHaveLength(20);
  expect(history.at(-1)?.high).toBe(758.555);
});

test("a corrupt holding cannot be silently dropped from estimated portfolio risk", () => {
  const targets = buildPortfolioChartTargets([riskTicker("SPY"), riskTicker("MSFT")]);
  const chartEntries = new Map(targets.map(({ request }, index) => [buildChartKey(request), {
    data: index === 0 ? [...riskHistory().slice(0, -1), rejectedSpy] : riskHistory(),
  }]));
  const input = { chartTargets: targets, chartEntries, financials: new Map(),
    columnContext: { activeTab: "main", baseCurrency: "USD", exchangeRates: new Map<string, number>(), now: 0 } };
  const result = buildPortfolioReturnSeries(input);
  expect(result).toMatchObject({ returns: null, coverage: 0.5, missingCount: 1 });
  expect(result.historyIntegrity[0]).toMatchObject({ symbol: "SPY", integrity: { sourcePoints: [{ ...rejectedSpy, date: "2026-09-10T00:00:00.000Z" }] } });
  const rows = buildAnalyticsRiskRows({ ...result, sharpe: 2, beta: 1 });
  expect(rows.every((row) => row.value === "—" && row.detail === "Inconsistent OHLC history: SPY")).toBe(true);
  chartEntries.set(buildChartKey(targets[0]!.request), { data: riskHistory() });
  expect(buildPortfolioReturnSeries(input).returns).toHaveLength(20);
  expect(buildPortfolioReturnSeries(input).historyIntegrity).toEqual([]);
});

test("converts every account balance while keeping leverage independent of display currency", () => {
  const accountState = {
    account: {
      accountId: "test", currency: "EUR", netLiquidation: 100_000, grossPositionValue: 150_000,
      totalCashValue: -50_000, settledCash: -40_000, availableFunds: 30_000,
      excessLiquidity: 20_000, buyingPower: 60_000,
    },
    sourceLabel: "Test broker",
  } as ResolvedPortfolioAccountState;
  const portfolioStats: PortfolioSummaryTotals = {
    totalMktValue: 0, totalCostBasis: 0, dailyPnl: 0, dailyPnlPct: 0,
    unrealizedPnl: 0, unrealizedPnlPct: 0, hasPositions: true, avgWatchlistChange: 0, watchlistCount: 0,
  };
  const rows = (rate: number) => new Map(buildAnalyticsSummaryRows({
    accountState, portfolioStats, activePortfolio: null, brokerPerformance: null,
    convertAccountValue: (value) => value * rate,
  }).map((row) => [row.id, row.value]));

  expect(rows(1).get("margin-leverage")).toBe("1.5x");
  const converted = rows(1.2);
  expect(converted.get("margin-leverage")).toBe("1.5x");
  expect(converted.get("net-liquidation")).toBe("120k");
  expect(converted.get("total-value")).toBe("180k");
  expect(converted.get("cash")).toBe("-60k");
  expect(converted.get("settled-cash")).toBe("-48k");
  expect(converted.get("available-funds")).toBe("36k");
  expect(converted.get("excess-liquidity")).toBe("24k");
  expect(converted.get("buying-power")).toBe("72k");

  accountState.account.netLiquidation = 0;
  expect(rows(1).has("margin-leverage")).toBe(false);
});

test("does not publish portfolio risk from just the valued portion when FX is missing", () => {
  const tickers = ["USD", "EUR"].map((currency): TickerRecord => ({ metadata: {
    ticker: currency === "USD" ? "AAPL" : "SAP", exchange: currency === "USD" ? "NASDAQ" : "XETRA", currency,
    name: currency, positions: [{ portfolio: "main", shares: 10, avgCost: 100, markPrice: 120, broker: "manual", currency }],
    portfolios: ["main"], watchlists: [], custom: {}, tags: [],
  } }));
  const targets = buildPortfolioChartTargets(tickers);
  const chartEntries = new Map(targets.map(({ request }) => [buildChartKey(request), {
    data: Array.from({ length: 20 }, (_, index) => ({ date: new Date(Date.UTC(2026, 0, index + 1)), close: 100 + index + index % 2 })),
  }]));
  const input = {
    chartTargets: targets, chartEntries, financials: new Map(),
    columnContext: { activeTab: "main", baseCurrency: "USD", exchangeRates: new Map<string, number>(), now: 0 },
  };
  const missing = buildPortfolioReturnSeries(input);
  expect(missing.returns).toBeNull();
  expect(missing.unvaluedCount).toBe(1);
  const riskRows = buildAnalyticsRiskRows({ sharpe: null, beta: null, ...missing });
  expect(riskRows.every((row) => row.value === "—" && row.detail?.includes("check prices and FX"))).toBe(true);

  input.columnContext.exchangeRates.set("EUR", 1.2);
  const restored = buildPortfolioReturnSeries(input);
  expect(restored.unvaluedCount).toBe(0);
  expect(restored.returns).toBeNull();
  expect(restored.unsupportedReason).toContain("historical FX");

  // USD price histories can support the explicitly labelled basket estimate.
  tickers[1]!.metadata.currency = "USD";
  tickers[1]!.metadata.positions[0]!.currency = "USD";
  expect(buildPortfolioReturnSeries(input).returns).toHaveLength(19);

  const position = tickers[0]!.metadata.positions[0]!;
  position.side = "short";
  const short = buildPortfolioReturnSeries(input);
  expect(short.returns).toBeNull();
  expect(short.unsupportedReason).toContain("Short positions");
  expect(buildAnalyticsRiskRows({ ...short, sharpe: 2, beta: 1 }).every((row) => row.value === "—")).toBe(true);
  position.side = undefined;
  position.shares = -10;
  expect(buildPortfolioReturnSeries(input).unsupportedReason).toContain("Short positions");
  position.shares = 10;
  position.multiplier = 100;
  expect(buildPortfolioReturnSeries(input).returns).toBeNull();
  position.multiplier = 1;

  const leveraged = buildPortfolioReturnSeries({
    ...input, account: { accountId: "test", name: "test", netLiquidation: 100, grossPositionValue: 150 },
  });
  expect(leveraged.returns).toBeNull();
  expect(leveraged.unsupportedReason).toContain("Leveraged account");

  const supported = buildAnalyticsRiskRows({ ...buildPortfolioReturnSeries(input), sharpe: 2, beta: 1 });
  expect(supported.map((row) => row.value)).toEqual(["2.00", "1.00"]);
});


test("risk row detail reflects partial or unavailable inputs while retaining valid zero estimates", () => {
  const healthy = buildAnalyticsRiskRows({ sharpe: 0, beta: 0 });
  expect(healthy.map((row) => [row.label, row.value, row.detail])).toEqual([
    ["Est. Sharpe", "0.00", undefined], ["Est. Beta (SPY)", "0.00", undefined],
  ]);
  const partial = buildAnalyticsRiskRows({ sharpe: 0, beta: null, coverage: .7, missingCount: 2 });
  expect(partial[0]).toMatchObject({ value: "0.00", detail: "Partial: +70.00% of value, 2 holdings pending" });
  expect(partial[1]).toMatchObject({ value: "—", detail: "Insufficient history for basket estimate" });
  const unavailable = buildAnalyticsRiskRows({ sharpe: 0, beta: 0, coverage: .7, missingCount: 2, unvaluedCount: 1 });
  expect(unavailable.every((row) => row.value === "—" && row.detail?.includes("check prices and FX"))).toBe(true);
});
