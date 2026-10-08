import type {
  CloudFredSeriesPayload,
  CloudMarketResponse,
  CloudPricePointPayload,
  CloudQuotePayload,
} from "../../../api-client/types";
import { getPublishedUsEquityCalendarDay } from "../../../market-data/published-us-sessions";
import { createTestTicker } from "../../../test-support/ticker";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import { canonicalExchange, normalizeSymbol } from "../../../utils/exchanges";
export const now = new Date("2026-09-22T12:00:00Z");
export const instrument = { symbol: "SPY", exchange: "ARCA" };
export const riskQuote = (symbol = "SPY", listing = "ARCA"): CloudQuotePayload => ({
  symbol,
  currency: "USD",
  price: 110,
  change: 1,
  changePercent: 1,
  lastUpdated: now.getTime() - 86_400_000,
  listingExchangeName: listing,
  providerId: "gloomberb-cloud",
  dataSource: "delayed",
});
export function riskHistory(): CloudMarketResponse<CloudPricePointPayload[]> {
  const data: CloudPricePointPayload[] = [];
  for (
    let day = Date.parse("2026-05-01");
    day <= Date.parse("2026-09-21");
    day += 86_400_000
  ) {
    const date = new Date(day),
      key = date.toISOString().slice(0, 10);
    if (
      [0, 6].includes(date.getUTCDay()) ||
      ["2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07"].includes(key)
    )
      continue;
    const close = 100 + data.length * 0.1 + Math.sin(data.length) * 2;
    data.push({
      date: date.toISOString(),
      open: close,
      high: close,
      low: close,
      close,
      volume: 100,
    });
  }
  return {
    status: "success",
    data,
    providerMeta: {
      servedResolution: "1d",
      currency: "USD",
      normalizedSymbol: "SPY",
      normalizedExchange: "ARCA",
    },
  };
}

/** One synthetic holding of the broker account below. */
interface BrokerFixtureHolding {
  symbol: string;
  exchange: string;
  currency: string;
  quantity: number;
  /** Listing price in its own currency; null when no market data covers the holding. */
  price: number | null;
  /** The broker's own snapshot market value in `currency`, for holdings no quote values. */
  brokerValue?: number;
}

/** USD per unit, as the rate endpoint reports each currency. */
const BROKER_FX_RATES: Readonly<Record<string, number>> = {
  EUR: 1.1,
  GBP: 1.25,
  HKD: 0.128,
  JPY: 0.0068,
  TWD: 0.031,
};
export const BROKER_PORTFOLIO: Portfolio = { id: "broker", name: "Broker account", currency: "USD" };

/**
 * A synthetic broker account the size of a real one: 85 US listings worth
 * $365,500 (quantity 1 to 85 at $100), six foreign listings worth $88,060 at
 * the rates above and three holdings no market data covers, worth $15,000 in
 * the broker's own snapshot. Covered share: 365,500 / 468,560 = 78.0%.
 */
export function brokerFixtureHoldings(): BrokerFixtureHolding[] {
  const us = Array.from({ length: 85 }, (_, index) => ({
    symbol: `US${String(index + 1).padStart(2, "0")}`,
    exchange: index % 2 ? "NYSE" : "NASDAQ",
    currency: "USD",
    quantity: index + 1,
    price: 100,
  }));
  const foreign = [
    { symbol: "EUR1", exchange: "XETRA", currency: "EUR", quantity: 300, price: 50 },
    { symbol: "EUR2", exchange: "EPA", currency: "EUR", quantity: 182, price: 100 },
    { symbol: "GBP1", exchange: "LSE", currency: "GBp", quantity: 500, price: 2_000 },
    { symbol: "HKD1", exchange: "HKEX", currency: "HKD", quantity: 2_000, price: 40 },
    { symbol: "JPY1", exchange: "JPX", currency: "JPY", quantity: 500, price: 3_000 },
    { symbol: "TWD1", exchange: "TWSE", currency: "TWD", quantity: 1_000, price: 600 },
  ];
  const unquoted = [
    { symbol: "UNQ1", exchange: "NASDAQ", currency: "USD", quantity: 400, price: null, brokerValue: 8_000 },
    { symbol: "UNQ2", exchange: "NYSE", currency: "USD", quantity: 250, price: null, brokerValue: 5_000 },
    { symbol: "UNQ3", exchange: "NASDAQ", currency: "USD", quantity: 100, price: null, brokerValue: 2_000 },
  ];
  // Broker order is alphabetical, so the uncovered holdings sit among the rest.
  return [...us, ...foreign, ...unquoted].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function brokerFixtureTickers(
  holdings: readonly BrokerFixtureHolding[] = brokerFixtureHoldings(),
  portfolioId = BROKER_PORTFOLIO.id,
): TickerRecord[] {
  return holdings.map((holding) =>
    createTestTicker(holding.symbol, holding.symbol, {
      exchange: holding.exchange,
      currency: holding.currency,
      portfolios: [portfolioId],
      positions: [{
        portfolio: portfolioId,
        shares: holding.quantity,
        currency: holding.currency,
        broker: "manual",
        ...(holding.brokerValue != null ? { marketValue: holding.brokerValue } : {}),
      }],
    }),
  );
}

/** Completed US sessions before `asOf`, oldest first. */
function sessionDates(asOf: Date, count: number): string[] {
  const dates: string[] = [];
  const today = asOf.toISOString().slice(0, 10);
  for (let day = Date.parse(today) - 86_400_000; dates.length < count; day -= 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (getPublishedUsEquityCalendarDay("NYSE", date) === "session") dates.push(date);
  }
  return dates.reverse();
}

/** Each symbol wobbles on its own phase, so the basket, SPY and the factor spreads differ. */
export function sessionHistory(
  symbol: string,
  exchange: string,
  asOf: Date = now,
  currency = "USD",
  sessions = 130,
): CloudMarketResponse<CloudPricePointPayload[]> {
  const phase = [...symbol].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 7;
  return {
    status: "success",
    data: sessionDates(asOf, sessions).map((date, index) => {
      const close = 100 + index * (0.05 + phase / 100) + Math.sin(index / 3 + phase) * 3;
      return { date: `${date}T00:00:00.000Z`, open: close, high: close, low: close, close, volume: 100 };
    }),
    providerMeta: { servedResolution: "1d", currency, normalizedSymbol: symbol, normalizedExchange: exchange },
  };
}

function fredSeries(id: string, asOf: Date): CloudFredSeriesPayload {
  return {
    info: {
      id,
      title: id,
      units: id === "DGS10" ? "Percent" : "Index",
      frequency: "Daily",
      seasonalAdjustment: "Not Seasonally Adjusted",
      source: "Illustrative",
      notes: "",
    },
    observations: sessionDates(asOf, 130).map((date, index) => ({
      date,
      value: id === "DGS10" ? 4 + Math.sin(index / 5) / 4 : 18 + Math.cos(index / 4) * 2,
    })),
  };
}

/**
 * Cloud responses for the broker account: US listings and the factor proxies
 * quote and keep daily history, foreign listings quote in their own currency,
 * the uncovered holdings have neither.
 */
export function brokerRiskClient(
  asOf: Date = now,
  holdings: readonly BrokerFixtureHolding[] = brokerFixtureHoldings(),
) {
  const bySymbol = new Map(holdings.map((holding) => [normalizeSymbol(holding.symbol), holding]));
  const find = (symbol: string) => bySymbol.get(normalizeSymbol(symbol));
  const calls = { quotes: 0, histories: [] as string[], rates: [] as string[] };
  const client = {
    calls,
    getCloudQuotesBatch: async (requested: Array<{ symbol: string; exchange?: string }>) => {
      calls.quotes += 1;
      return {
        status: "success" as const,
        data: {
          items: requested.map((row) => {
            const holding = find(row.symbol);
            if (holding && holding.price == null)
              return { ...row, status: "empty" as const, data: null };
            return {
              ...row,
              status: "success" as const,
              data: {
                ...riskQuote(row.symbol, holding?.exchange ?? row.exchange ?? ""),
                currency: holding?.currency ?? "USD",
                price: holding?.price ?? 110,
                lastUpdated: asOf.getTime() - 60_000,
              },
            };
          }),
        },
      };
    },
    getCloudHistory: async (symbol: string, exchange: string) => {
      calls.histories.push(symbol);
      const holding = find(symbol);
      if (holding && holding.price == null)
        return { status: "empty" as const, data: null, reasonCode: "Daily history unavailable" };
      return sessionHistory(symbol, canonicalExchange(exchange), asOf, holding?.currency ?? "USD");
    },
    getCloudFredSeries: async (id: string) => fredSeries(id, asOf),
    getCloudExchangeRate: async (currency: string) => {
      calls.rates.push(currency);
      const rate = BROKER_FX_RATES[currency];
      return rate == null
        ? { status: "empty" as const, data: null }
        : { status: "success" as const, data: { rate } };
    },
  };
  return client;
}
