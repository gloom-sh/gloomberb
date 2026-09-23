import { expect, test } from "bun:test";
import { hydrateTickerMetadata } from "../../../tickers/metadata";
import { createDefaultConfig } from "../../../types/config";
import type { TickerPosition, TickerRecord } from "../../../types/ticker";
import type { TickerFinancials } from "../../../types/financials";
import { buildPositionRows } from "../ticker-detail/overview/model";
import { buildSetPortfolioPositionWorkflow } from "./command-bar";
import { setManualPortfolioPosition } from "./mutations";
import { getPortfolioPositionMetrics, resolvePortfolioPositionPnl, resolveBrokerFallbackMarketValue } from "./position-metrics";
import { calculatePortfolioSummaryTotals, getColumnValue, getSortValue } from "./metrics";
import { buildPortfolioSummarySegments } from "./summary";

const now = Date.now();
const financials: TickerFinancials = {
  quote: { symbol: "AAPL", price: 120, currency: "USD", change: 0, changePercent: 0, previousClose: 120, lastUpdated: now },
  annualStatements: [], quarterlyStatements: [], priceHistory: [],
};
const context = { activeTab: "main", baseCurrency: "USD", exchangeRates: new Map([["USD", 1]]), now };
const lot = (overrides: Partial<TickerPosition> = {}): TickerPosition => ({ portfolio: "main", broker: "manual", shares: 10, currency: "USD", ...overrides });
const ticker = (...positions: TickerPosition[]): TickerRecord => ({ metadata: {
  ticker: "AAPL", name: "Apple", exchange: "NASDAQ", currency: "USD", assetCategory: "STK",
  positions, portfolios: ["main"], watchlists: [], custom: {}, tags: [],
} });
const totals = (record: TickerRecord, source = financials) => calculatePortfolioSummaryTotals(
  [record], new Map([["AAPL", source]]), "USD", context.exchangeRates, true, "main",
);
const column = (id: string) => ({ id, label: id, width: 12, align: "right" as const });

test("missing cost is unavailable across hydration, cells, sorting, summary and overview; zero remains explicit", () => {
  for (const raw of [{}, { avgCost: null, avg_cost: 100 }, { avgCost: Number.NaN }, { avgCost: Infinity }]) {
    const original = ticker(lot(raw as Partial<TickerPosition>));
    const record = { metadata: hydrateTickerMetadata(JSON.parse(JSON.stringify(original.metadata))) };
    expect(record.metadata.positions[0]!.avgCost).toBeUndefined();
    expect(totals(record).unrealizedPnl).toBeNaN();
    expect(totals(record).unrealizedPnlPct).toBeNaN();
    for (const id of ["avg_cost", "cost_basis", "pnl", "pnl_pct"]) {
      expect(getColumnValue(column(id), record, financials, context).text).toBe("—");
      expect(getSortValue(column(id), record, financials, context)).toBeNull();
    }
    const row = buildPositionRows({ ticker: record, quote: financials.quote, quoteCurrency: "USD", baseCurrency: "USD", toBase: value => value })[0]!;
    expect(row).toMatchObject({ pnlValue: null, pnlBasis: "unavailable", avg: "—", cost: "—", ret: "—" });
  }
  for (const raw of [{ avgCost: 0 }, { avg_cost: 0 }]) {
    const record = { metadata: hydrateTickerMetadata({ ...ticker().metadata, positions: [{ ...lot(), ...raw }] }) };
    expect(record.metadata.positions[0]!.avgCost).toBe(0);
    expect(totals(record)).toMatchObject({ totalCostBasis: 0, unrealizedPnl: 1200, unrealizedPnlPct: Number.NaN });
    expect(getSortValue(column("cost_basis"), record, financials, context)).toBe(0);
    expect(getColumnValue(column("cost_basis"), record, financials, context).text).toBe("0");
    expect(getColumnValue(column("pnl_pct"), record, financials, context).text).toBe("—");
  }
});

test("a current mark cannot refresh broker profit without cost, and manual correction restores current calculations", () => {
  const record = ticker(lot({ unrealizedPnl: 200, marketValue: 1150, markPrice: 115 }));
  expect(totals(record)).toMatchObject({ totalMktValue: 1200, totalCostBasis: Number.NaN, unrealizedPnl: 200, unrealizedPnlPct: Number.NaN,
    unrealizedPnlBasis: "broker-snapshot", unavailableCostSymbols: ["AAPL"], brokerPnlSymbols: ["AAPL"] });
  expect(getColumnValue(column("pnl"), record, financials, context)).toMatchObject({ text: "+200", pnlBasis: "broker-snapshot" });
  expect(getSortValue(column("pnl"), record, financials, context)).toBe(200);
  const summary = buildPortfolioSummarySegments({ totals: totals(record), accountState: null });
  expect(summary.flatMap(segment => segment.parts.map(part => part.text)).join(" ")).toContain("Broker P&L");
  const config = createDefaultConfig("/unused-cost-recovery");
  expect(buildSetPortfolioPositionWorkflow(config, { activeCollectionId: "main", activeTicker: record })?.values.avgCost).toBe("");
  const restored = setManualPortfolioPosition(record, "main", { shares: 10, avgCost: 105, currency: "USD" }).ticker;
  expect(restored.metadata.positions[0]).toMatchObject({ avgCost: 105 });
  expect(restored.metadata.positions[0]!.unrealizedPnl).toBeUndefined();
  expect(totals(restored)).toMatchObject({ totalCostBasis: 1050, unrealizedPnl: 150, unrealizedPnlBasis: "quote-and-cost" });
  expect(totals(restored).unavailableCostSymbols).toBeUndefined();
});

test("mixed lots select each independently, preserve offsetting exposure, and withhold an incomplete sum", () => {
  const record = ticker(lot({ avgCost: 100 }), lot({ shares: -10, unrealizedPnl: 50 }));
  expect(totals(record)).toMatchObject({ netMktValue: 0, totalMktValue: 2400, unrealizedPnl: 250,
    unrealizedPnlBasis: "mixed", totalCostBasis: Number.NaN, unrealizedPnlPct: Number.NaN });
  expect(getColumnValue(column("pnl"), record, financials, context)).toMatchObject({ text: "+250", pnlBasis: "mixed" });
  expect(getSortValue(column("pnl"), record, financials, context)).toBe(250);
  record.metadata.positions.push(lot({ shares: 1 }));
  expect(totals(record).unrealizedPnl).toBeNaN();
  expect(getSortValue(column("pnl"), record, financials, context)).toBeNull();
});

test("lot currencies convert before selection, including a quote in a third currency", () => {
  const record = ticker(lot({ avgCost: 100, currency: "EUR" }), lot({ shares: -10, currency: "GBP", unrealizedPnl: 40 }));
  const source = { ...financials, quote: { ...financials.quote!, price: 13000, currency: "JPY" } };
  const rates = new Map([["EUR", 1.1], ["GBP", 1.25], ["JPY", 0.01]]);
  const result = calculatePortfolioSummaryTotals([record], new Map([["AAPL", source]]), "USD", rates, true, "main");
  expect(result).toMatchObject({ unrealizedPnl: 250, unrealizedPnlBasis: "mixed", totalCostBasis: Number.NaN });
  rates.delete("GBP");
  expect(calculatePortfolioSummaryTotals([record], new Map([["AAPL", source]]), "USD", rates, true, "main").unrealizedPnl).toBeNaN();
});

test("profit alone never manufactures cost or a complete market value, and overflow stays unavailable", () => {
  const metrics = getPortfolioPositionMetrics(ticker(lot({ unrealizedPnl: 200 })), "main", "USD");
  expect(metrics.hasBrokerMktValue).toBe(false);
  expect(resolveBrokerFallbackMarketValue(metrics)).toBeNull();
  expect(resolvePortfolioPositionPnl(metrics)).toEqual({ value: 200, basis: "broker-snapshot" });
  const absentQuote = { ...financials, quote: undefined };
  expect(totals(ticker(lot({ unrealizedPnl: 200 })), absentQuote)).toMatchObject({ totalMktValue: Number.NaN, unrealizedPnl: 200, unavailableSymbols: ["AAPL"] });
  const overflow = getPortfolioPositionMetrics(ticker(lot({ shares: Number.MAX_VALUE, markPrice: 2 })), "main", "USD");
  expect(overflow.hasBrokerMktValue).toBe(false);
  expect(resolvePortfolioPositionPnl(overflow, 2)).toEqual({ value: null, basis: "unavailable" });
});
