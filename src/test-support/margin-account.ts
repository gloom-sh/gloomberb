import type { Quote, TickerFinancials } from "../types/financials";
import type { Portfolio, TickerRecord } from "../types/ticker";
import type { BrokerAccount } from "../types/trading";
import { createTestTicker } from "./ticker";

/**
 * An invented margin account: 1.0M of equity carrying 1.6M of positions, the
 * difference borrowed in three currencies. It holds a US stock, a listing
 * quoted in euros and an option, which no quote prices, so it stays at its
 * broker mark. Every figure is made up.
 */
export const MARGIN_PORTFOLIO: Portfolio = {
  id: "broker:margin-test:M1",
  name: "Margin test",
  currency: "USD",
  brokerId: "test",
  brokerInstanceId: "margin-test",
  brokerAccountId: "M1",
};

/** Dollars per unit of each currency. */
export const MARGIN_EXCHANGE_RATES = new Map([["USD", 1], ["EUR", 1.2], ["JPY", 0.008]]);

const OPTION = "CCC   280121C00050000";

function holding(symbol: string, details: {
  exchange: string;
  currency: string;
  shares: number;
  mark: number;
  multiplier?: number;
  assetCategory?: string;
}): TickerRecord {
  return createTestTicker(symbol, symbol, {
    exchange: details.exchange,
    currency: details.currency,
    assetCategory: details.assetCategory,
    portfolios: [MARGIN_PORTFOLIO.id],
    positions: [{
      portfolio: MARGIN_PORTFOLIO.id,
      shares: details.shares,
      avgCost: details.mark,
      markPrice: details.mark,
      marketValue: details.shares * details.mark * (details.multiplier ?? 1),
      unrealizedPnl: 0,
      multiplier: details.multiplier,
      currency: details.currency,
      side: "long",
      broker: "test",
      brokerInstanceId: "margin-test",
      brokerAccountId: "M1",
    }],
  });
}

export const MARGIN_TICKERS: TickerRecord[] = [
  holding("AAA", { exchange: "NASDAQ", currency: "USD", shares: 4_000, mark: 200 }),
  holding("BBB", { exchange: "XETRA", currency: "EUR", shares: 5_000, mark: 100 }),
  holding(OPTION, { exchange: "", currency: "USD", shares: 20, mark: 100, multiplier: 100, assetCategory: "OPT" }),
];

export function createMarginAccount(overrides: Partial<BrokerAccount> = {}): BrokerAccount {
  return {
    accountId: "M1",
    name: "Margin test",
    currency: "USD",
    source: "cloud",
    updatedAt: Date.now() - 60_000,
    netLiquidation: 1_000_000,
    grossPositionValue: 1_600_000,
    totalCashValue: -600_000,
    cashBalances: [
      { currency: "EUR", quantity: -250_000, baseValue: -300_000, baseCurrency: "USD" },
      { currency: "JPY", quantity: -25_000_000, baseValue: -200_000, baseCurrency: "USD" },
      { currency: "USD", quantity: -100_000, baseValue: -100_000, baseCurrency: "USD" },
    ],
    ...overrides,
  };
}

function liveQuote(symbol: string, price: number, previousClose: number, currency: string, exchange: string): TickerFinancials {
  const quote: Quote = {
    symbol,
    price,
    change: price - previousClose,
    changePercent: (price / previousClose - 1) * 100,
    previousClose,
    currency,
    lastUpdated: Date.now() - 1_000,
    listingExchangeName: exchange,
    marketState: "REGULAR",
    dataSource: "live",
  };
  return { annualStatements: [], quarterlyStatements: [], priceHistory: [], quote };
}

/**
 * Real-time quotes for the stock and the euro listing, the stock `move`
 * dollars above its mark. With `option`, the option is quoted at its mark too,
 * so every position has a live price.
 */
export function marginQuotes({ move = 0, option = false }: { move?: number; option?: boolean } = {}): Map<string, TickerFinancials> {
  return new Map([
    ["AAA", liveQuote("AAA", 200 + move, 200, "USD", "NASDAQ")],
    ["BBB", liveQuote("BBB", 100, 100, "EUR", "XETRA")],
    ...(option ? [[OPTION, liveQuote(OPTION, 100, 100, "USD", "CBOE")] as const] : []),
  ]);
}
