import { expect, test } from "bun:test";
import type { TickerRecord } from "../../../types/ticker";
import type { PricePoint } from "../../../types/financials";
import { buildChartKey } from "../../../market-data/selectors";
import { buildBenchmarkReturnSeries, buildPortfolioChartTargets, buildPortfolioReturnSeries } from "./pane-model";
import { createTestTicker } from "../../../test-support/ticker";

function riskTicker(symbol: string): TickerRecord {
  return createTestTicker(symbol, symbol, {
    exchange: "NYSE",
    positions: [{ portfolio: "main", shares: 10, avgCost: 100, markPrice: 120, broker: "manual", currency: "USD" }],
    portfolios: ["main"],
  });
}

function riskHistory(): PricePoint[] {
  return Array.from({ length: 21 }, (_, index) => ({ date: new Date(Date.UTC(2026, 7, 21 + index)), close: 740 + index + index % 2 }));
}

// A reported SPY bar whose open lies above its high.
const rejectedSpy = { date: new Date("2026-09-10"), open: 764.08, high: 758.555, low: 757.57, close: 758.15, volume: 3461376 };

test("a rejected benchmark bar quarantines its returns until corrected history arrives", () => {
  const request = buildPortfolioChartTargets([riskTicker("SPY")])[0]!.request!;
  const history = [...riskHistory().slice(0, -1), rejectedSpy];
  const entries = new Map([[buildChartKey(request), { data: history }]]);
  const result = buildBenchmarkReturnSeries(request, entries);
  expect(result.returns).toEqual([]);
  expect(result.integrity?.sourcePoints[0]).toMatchObject({ open: 764.08, high: 758.555, close: 758.15 });
  entries.set(buildChartKey(request), { data: riskHistory() });
  expect(buildBenchmarkReturnSeries(request, entries)).toMatchObject({ integrity: null });
  expect(buildBenchmarkReturnSeries(request, entries).returns).toHaveLength(20);
  expect(history.at(-1)?.high).toBe(758.555);
});

test("a corrupt holding cannot be silently dropped from estimated portfolio risk", () => {
  const targets = buildPortfolioChartTargets([riskTicker("SPY"), riskTicker("MSFT")]);
  const chartEntries = new Map(targets.map(({ request }, index) => [buildChartKey(request!), {
    data: index === 0 ? [...riskHistory().slice(0, -1), rejectedSpy] : riskHistory(),
  }]));
  const input = { chartTargets: targets, chartEntries, financials: new Map(),
    columnContext: { activeTab: "main", baseCurrency: "USD", exchangeRates: new Map<string, number>(), now: 0 } };
  const result = buildPortfolioReturnSeries(input);
  expect(result).toMatchObject({ returns: null, coverage: 0.5, missingCount: 1 });
  expect(result.historyIntegrity[0]).toMatchObject({ symbol: "SPY", integrity: { sourcePoints: [{ ...rejectedSpy, date: "2026-09-10T00:00:00.000Z" }] } });
  chartEntries.set(buildChartKey(targets[0]!.request!), { data: riskHistory() });
  expect(buildPortfolioReturnSeries(input).returns).toHaveLength(20);
  expect(buildPortfolioReturnSeries(input).historyIntegrity).toEqual([]);
});

test("does not publish portfolio risk from just the valued portion when FX is missing", () => {
  const tickers = ["USD", "EUR"].map((currency): TickerRecord => (createTestTicker(currency === "USD" ? "AAPL" : "SAP", currency, {
    exchange: currency === "USD" ? "NASDAQ" : "XETRA",
    currency,
    positions: [{ portfolio: "main", shares: 10, avgCost: 100, markPrice: 120, broker: "manual", currency }],
    portfolios: ["main"],
  })));
  const targets = buildPortfolioChartTargets(tickers);
  const sessionDates = ["01", "02", "03", "04", "05", "08", "09", "10", "11", "12", "15", "16", "17", "18", "22", "23", "24", "25", "26", "29"];
  const chartEntries = new Map(targets.map(({ request }) => [buildChartKey(request!), {
    data: sessionDates.map((day, index) => ({ date: new Date(`2026-06-${day}`), close: 100 + index + index % 2 })),
  }]));
  const input = {
    chartTargets: targets, chartEntries, financials: new Map(),
    columnContext: { activeTab: "main", baseCurrency: "USD", exchangeRates: new Map<string, number>(), now: 0 },
  };
  const missing = buildPortfolioReturnSeries(input);
  expect(missing.returns).toBeNull();
  expect(missing.unvaluedCount).toBe(1);

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
});
