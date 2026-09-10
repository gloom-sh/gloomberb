import { expect, test } from "bun:test";
import type { ResolvedPortfolioAccountState } from "../portfolio-list/summary";
import type { PortfolioSummaryTotals } from "../portfolio-list/metrics";
import type { TickerRecord } from "../../../types/ticker";
import { buildChartKey } from "../../../market-data/selectors";
import { buildAnalyticsRiskRows, buildAnalyticsSummaryRows, buildPortfolioChartTargets, buildPortfolioReturnSeries } from "./pane-model";

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
  expect(supported.every((row) => row.label.startsWith("Est.") && row.detail?.includes("Current weights"))).toBe(true);
  expect(supported[0]!.detail).toContain("5% Rf, 252 sessions");
});
