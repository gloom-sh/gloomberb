import { describe, expect, test } from "bun:test";
import type { CollectionSortPreference } from "../../../state/app/context";
import type { ColumnConfig } from "../../../types/config";
import type { Quote, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { blendHex, colors } from "../../../theme/colors";
import {
  calculatePortfolioSummaryTotals,
  getColumnValue,
  getSortValue,
  resolveCollectionSortPreference,
  resolvePortfolioPriceValue,
  type ColumnContext,
} from "./metrics";

function createTicker(overrides: Partial<TickerRecord["metadata"]> = {}): TickerRecord {
  return {
    metadata: {
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple Inc.",
      positions: [],
      portfolios: [],
      watchlists: [],
      custom: {},
      tags: [],
      ...overrides,
    },
  };
}

function createFinancials(
  overrides: Omit<Partial<TickerFinancials>, "quote"> & { quote?: Partial<Quote> } = {},
): TickerFinancials {
  const { quote: quoteOverrides, ...financialOverrides } = overrides;
  return {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
    ...financialOverrides,
    quote: {
      symbol: "AAPL",
      price: 120,
      currency: "USD",
      change: 5,
      changePercent: 4.35,
      previousClose: 115,
      lastUpdated: 1_700_000_000_000,
      ...quoteOverrides,
    },
  };
}

const defaultColumnContext: ColumnContext = {
  activeTab: "main",
  baseCurrency: "USD",
  exchangeRates: new Map([["USD", 1]]),
  now: 1_700_000_010_000,
};

describe("portfolio-metrics", () => {
  test("defaults portfolio tabs to market value descending", () => {
    expect(resolveCollectionSortPreference("main", true, {})).toEqual({
      columnId: "mkt_value",
      direction: "desc",
    } satisfies CollectionSortPreference);
  });

  test("leaves watchlists unsorted by default and respects persisted overrides", () => {
    expect(resolveCollectionSortPreference("watchlist", false, {})).toEqual({
      columnId: null,
      direction: "asc",
    } satisfies CollectionSortPreference);
    expect(resolveCollectionSortPreference("main", true, {
      main: { columnId: "pnl", direction: "asc" },
    })).toEqual({
      columnId: "pnl",
      direction: "asc",
    } satisfies CollectionSortPreference);
  });

  test("shows broker mark price when no live quote is available", () => {
    expect(resolvePortfolioPriceValue(null, 382.5)).toEqual({
      text: "382.5",
    });
  });

  test("mutes completed-session prices and changes without discarding their direction", () => {
    const ticker = createTicker({
      positions: [{ portfolio: "main", shares: 10, avgCost: 100, broker: "manual" }],
    });
    const priceColumn: ColumnConfig = { id: "price", label: "LAST", width: 10, align: "right" };
    const changeColumn: ColumnConfig = { id: "change", label: "CHG", width: 8, align: "right" };
    const changePctColumn: ColumnConfig = { id: "change_pct", label: "CHG%", width: 8, align: "right" };
    const financials = createFinancials({ quote: { marketState: "CLOSED" } });
    const mutedPositive = blendHex(colors.positive, colors.textDim, 0.55);

    expect(getColumnValue(priceColumn, ticker, financials, defaultColumnContext)).toEqual({
      text: "120",
      color: colors.textDim,
    });
    expect(getColumnValue(changeColumn, ticker, financials, defaultColumnContext)).toEqual({
      text: "+5",
      color: mutedPositive,
    });
    expect(getColumnValue(changePctColumn, ticker, financials, defaultColumnContext)).toEqual({
      text: "+4.35%",
      color: mutedPositive,
    });
    const unchanged = createFinancials({ quote: { change: 0, changePercent: 0, previousClose: 120, marketState: "CLOSED" } });
    expect(getColumnValue(changePctColumn, ticker, unchanged, defaultColumnContext)).toEqual({
      text: "0.00%",
      color: colors.neutral,
    });

    const open = createFinancials({ quote: { marketState: "REGULAR" } });
    expect(getColumnValue(priceColumn, ticker, open, defaultColumnContext).color).toBe(colors.positive);
    expect(getColumnValue(changePctColumn, ticker, open, defaultColumnContext).color).toBe(colors.positive);
  });

  test("calculates portfolio totals from live quotes", () => {
    const ticker = createTicker({
      positions: [{ portfolio: "main", shares: 10, avgCost: 100, broker: "manual" }],
    });
    const financialsMap = new Map([["AAPL", createFinancials()]]);

    expect(calculatePortfolioSummaryTotals(
      [ticker],
      financialsMap,
      "USD",
      new Map([["USD", 1]]),
      true,
      "main",
    )).toMatchObject({
      totalMktValue: 1200,
      totalCostBasis: 1000,
      dailyPnl: 50,
      unrealizedPnl: 200,
      hasPositions: true,
    });
  });

  test("falls back to broker values when no quote is available", () => {
    const ticker = createTicker({
      positions: [{
        portfolio: "main",
        shares: 10,
        avgCost: 100,
        broker: "ibkr",
        marketValue: 1250,
        unrealizedPnl: 250,
      }],
    });
    const financialsMap = new Map<string, TickerFinancials>();

    expect(calculatePortfolioSummaryTotals(
      [ticker],
      financialsMap,
      "USD",
      new Map([["USD", 1]]),
      true,
      "main",
    )).toMatchObject({
      totalMktValue: 1250,
      totalCostBasis: 1000,
      dailyPnl: 0,
      unrealizedPnl: 250,
      hasPositions: true,
    });
  });

  test("does not double-apply IBKR option multipliers when avgCost is already contract-scaled", () => {
    const ticker = createTicker({
      ticker: "AMD   270917C00230000",
      assetCategory: "OPT",
      positions: [{
        portfolio: "main",
        shares: 10,
        avgCost: 5095.07295,
        broker: "ibkr",
        currency: "USD",
        marketValue: 58803.06,
        unrealizedPnl: 7852.33,
        multiplier: 100,
        markPrice: 58.8030586,
      }],
    });
    const financialsMap = new Map<string, TickerFinancials>();

    const totals = calculatePortfolioSummaryTotals(
      [ticker],
      financialsMap,
      "USD",
      new Map([["USD", 1]]),
      true,
      "main",
    );

    expect(totals.totalMktValue).toBeCloseTo(58803.06, 2);
    expect(totals.totalCostBasis).toBeCloseTo(50950.7295, 4);
    expect(totals.unrealizedPnl).toBeCloseTo(7852.33, 4);
    expect(totals.hasPositions).toBe(true);
  });

  test("keeps option avg cost display contract-scaled while using the correct cost basis", () => {
    const ticker = createTicker({
      ticker: "AMD   270917C00230000",
      assetCategory: "OPT",
      positions: [{
        portfolio: "main",
        shares: 10,
        avgCost: 5095.07295,
        broker: "ibkr",
        currency: "USD",
        marketValue: 58803.06,
        unrealizedPnl: 7852.33,
        multiplier: 100,
        markPrice: 58.8030586,
      }],
    });
    const financials = createFinancials({
      quote: {
        symbol: "AMD   270917C00230000",
        price: 58.8030586,
        currency: "USD",
        change: 0,
        changePercent: 0,
        previousClose: 58.8030586,
      },
    });
    const avgCostColumn: ColumnConfig = { id: "avg_cost", label: "AVG COST", width: 10, align: "right", format: "currency" };
    const pnlColumn: ColumnConfig = { id: "pnl", label: "P&L", width: 10, align: "right", format: "compact" };

    expect(getColumnValue(avgCostColumn, ticker, financials, defaultColumnContext)).toEqual({
      text: "5,095.073",
    });
    expect(getColumnValue(pnlColumn, ticker, financials, defaultColumnContext)).toEqual({
      text: "+7.9k",
      color: expect.any(String),
    });
  });

  test("formats equity average cost with tighter precision than quote prices", () => {
    const ticker = createTicker({
      assetCategory: "STK",
      positions: [{ portfolio: "main", shares: 10, avgCost: 119.3687, broker: "manual", currency: "HKD" }],
    });
    const avgCostColumn: ColumnConfig = { id: "avg_cost", label: "AVG COST", width: 10, align: "right", format: "currency" };

    expect(getColumnValue(avgCostColumn, ticker, undefined, defaultColumnContext)).toEqual({
      text: "119.37",
    });
  });

  test("formats portfolio-only column values and sort keys consistently", () => {
    const ticker = createTicker({
      positions: [{ portfolio: "main", shares: 10, avgCost: 100, broker: "manual" }],
    });
    const financials = createFinancials();
    const dayPnlColumn: ColumnConfig = { id: "day_pnl", label: "DAY", width: 10, align: "right", format: "compact" };
    const pnlColumn: ColumnConfig = { id: "pnl", label: "P&L", width: 10, align: "right", format: "compact" };
    const latencyColumn: ColumnConfig = { id: "latency", label: "AGE", width: 6, align: "right" };

    expect(getColumnValue(dayPnlColumn, ticker, financials, defaultColumnContext)).toEqual({
      text: "+50",
      color: expect.any(String),
    });
    expect(getSortValue(dayPnlColumn, ticker, financials, defaultColumnContext)).toBe(50);
    expect(getColumnValue(pnlColumn, ticker, financials, defaultColumnContext)).toEqual({
      text: "+200",
      color: expect.any(String),
    });
    expect(getSortValue(pnlColumn, ticker, financials, defaultColumnContext)).toBe(200);
    expect(getColumnValue(latencyColumn, ticker, financials, defaultColumnContext)).toEqual({
      text: "10s",
    });
  });

  test("signs short unrealized P&L from a live quote", () => {
    const ticker = createTicker({
      positions: [{ portfolio: "main", shares: 10, avgCost: 100, broker: "ibkr", side: "short" }],
    });
    const financials = createFinancials({
      quote: { price: 80, change: -20, changePercent: -20, previousClose: 100 },
    });
    const dayPnlColumn: ColumnConfig = { id: "day_pnl", label: "DAY", width: 10, align: "right", format: "compact" };
    const pnlColumn: ColumnConfig = { id: "pnl", label: "P&L", width: 10, align: "right", format: "compact" };

    expect(getSortValue(dayPnlColumn, ticker, financials, defaultColumnContext)).toBe(200);
    expect(getSortValue(pnlColumn, ticker, financials, defaultColumnContext)).toBe(200);
    expect(getColumnValue(pnlColumn, ticker, financials, defaultColumnContext)).toEqual({
      text: "+200",
      color: expect.any(String),
    });
    expect(calculatePortfolioSummaryTotals(
      [ticker],
      new Map([["AAPL", financials]]),
      "USD",
      new Map([["USD", 1]]),
      true,
      "main",
    )).toMatchObject({
      totalMktValue: 800,
      dailyPnl: 200,
      unrealizedPnl: 200,
    });
  });

  test("formats derived quote and position columns", () => {
    const ticker = createTicker({
      sector: "Technology",
      industry: "Consumer Electronics",
      assetCategory: "STK",
      tags: ["core", "mega"],
      positions: [{
        portfolio: "main",
        shares: 10,
        avgCost: 100,
        broker: "manual",
        currency: "USD",
        dateAcquired: "2024-01-01",
        markPrice: 121.2,
      }],
    });
    const financials = createFinancials({
      quote: {
        symbol: "AAPL",
        price: 120,
        currency: "USD",
        change: 5,
        changePercent: 4.35,
        previousClose: 115,
        bid: 119.5,
        ask: 120.5,
        bidSize: 100,
        askSize: 150,
        high52w: 160,
        low52w: 80,
        volume: 12_500_000,
      },
    });
    const context: ColumnContext = {
      ...defaultColumnContext,
      portfolioTotalMarketValue: 2_400,
      now: Date.UTC(2026, 0, 1),
    };

    expect(getColumnValue({ id: "weight", label: "WEIGHT", width: 8, align: "right" }, ticker, financials, context).text).toBe("+50.00%");
    expect(getSortValue({ id: "weight", label: "WEIGHT", width: 8, align: "right" }, ticker, financials, context)).toBe(50);
    expect(getColumnValue({ id: "range_52w", label: "52W%", width: 7, align: "right" }, ticker, financials, context).text).toBe("+50.00%");
    expect(getColumnValue({ id: "dollar_volume", label: "$VOL", width: 9, align: "right" }, ticker, financials, context).text).toBe("1.5B");
    expect(getColumnValue({ id: "spread_pct", label: "SPR%", width: 7, align: "right" }, ticker, financials, context).text).toBe("+0.83%");
    expect(getColumnValue({ id: "bid_ask_size", label: "B/A SZ", width: 9, align: "right" }, ticker, financials, context).text).toBe("100/150");
    expect(getColumnValue({ id: "mark_delta", label: "MARK%", width: 8, align: "right" }, ticker, financials, context).text).toBe("+1.00%");
    expect(getColumnValue({ id: "held", label: "HELD", width: 6, align: "right" }, ticker, financials, context).text).toBe("2.0y");
    expect(getColumnValue({ id: "tags", label: "TAGS", width: 14, align: "left" }, ticker, financials, context).text).toBe("core,mega");
  });

  test("formats supplemental analyst and corporate action columns", () => {
    const ticker = createTicker();
    const financials = createFinancials();
    const context: ColumnContext = {
      ...defaultColumnContext,
      analystResearch: new Map([["AAPL", {
        symbol: "AAPL",
        currency: "USD",
        priceTarget: { average: 150, current: 120, currency: "USD" },
        recommendationRating: 8.4,
        recommendations: [],
        ratings: [],
        earningsEstimates: [],
        revenueEstimates: [],
      }]]),
      corporateActions: new Map([["AAPL", {
        symbol: "AAPL",
        dividends: [{ exDate: "2026-02-15", amount: 0.25 }],
        splits: [],
        earnings: [{ date: "2026-01-30", epsEstimate: 1.2 }],
      }]]),
      earningsEvents: new Map([["AAPL", {
        symbol: "AAPL",
        name: "Apple Inc.",
        earningsDate: new Date(Date.UTC(2026, 0, 29)),
        earningsCallDate: null,
        epsEstimate: 1.2,
        epsActual: null,
        revenueEstimate: null,
        revenueActual: null,
        surprise: null,
        timing: "AMC",
      }]]),
    };

    expect(getColumnValue({ id: "target", label: "TARGET", width: 10, align: "right" }, ticker, financials, context).text).toBe("$150");
    expect(getColumnValue({ id: "target_pct", label: "TARGET%", width: 8, align: "right" }, ticker, financials, context).text).toBe("+25.00%");
    expect(getColumnValue({ id: "rating", label: "RATING", width: 7, align: "right" }, ticker, financials, context).text).toBe("8.4");
    expect(getColumnValue({ id: "ex_div", label: "EX-DIV", width: 7, align: "right" }, ticker, financials, context).text).toBe("Feb 15");
    expect(getColumnValue({ id: "next_earn", label: "ERN", width: 7, align: "right" }, ticker, financials, context).text).toBe("Jan 29");
    expect(getSortValue({ id: "target_pct", label: "TARGET%", width: 8, align: "right" }, ticker, financials, context)).toBe(25);
  });
});
