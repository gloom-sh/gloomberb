import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext } from "../../../types/headless";
import type { TickerRecord } from "../../../types/ticker";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import { collectionHoldingsHeadless } from "./headless";

const BROKER = { id: "broker:ibkr-main:U1234567", name: "U1234567", currency: "USD", brokerId: "ibkr", brokerInstanceId: "ibkr-main", brokerAccountId: "U1234567" };
const MANUAL = { id: "main", name: "Main", currency: "USD" };

function holding(symbol: string, shares: number, avgCost: number, portfolio = BROKER.id): TickerRecord {
  return createTestTicker(symbol, `${symbol} Inc`, {
    portfolios: [portfolio],
    positions: [{ portfolio, shares, avgCost, currency: "USD", broker: portfolio === BROKER.id ? "ibkr" : "manual" }],
  });
}

const prices: Record<string, number> = { NVDA: 100, MSFT: 400, AAPL: 200, TSLA: 250, SPY: 500 };
const tickers = [
  holding("1211", 2_000, 250),
  holding("NVDA", 100, 50),
  holding("MSFT", 30, 300),
  holding("AAPL", 10, 150),
  holding("TSLA", -20, 300),
  createTestTicker("SPY", "SPDR S&P 500", { watchlists: ["tech"] }),
];

function context(): HeadlessPaneContext {
  const config = {
    ...createDefaultConfig("/unused/pf-headless"),
    portfolios: [MANUAL, BROKER],
    watchlists: [{ id: "tech", name: "Tech" }],
  };
  return {
    config,
    signal: new AbortController().signal,
    marketData: createTestDataProvider({
      getQuote: async (symbol) => {
        if (!prices[symbol]) throw new Error(`No quote for ${symbol}`);
        return createTestQuote({ symbol, price: prices[symbol], changePercent: 1.5 });
      },
    }),
    resolvePortfolio: async (id: string) => {
      const portfolio = config.portfolios.find((entry) => entry.id === id);
      return portfolio ? { portfolio, tickers: tickers.filter((entry) => entry.metadata.portfolios.includes(id)) } : null;
    },
    resolveWatchlist: async (id: string) => tickers.filter((entry) => entry.metadata.watchlists.includes(id)),
  } as unknown as HeadlessPaneContext;
}

function args(rawArgument: string, options: Record<string, number> = {}) {
  return { rawArgument, argument: rawArgument || null, symbols: [], options };
}

test("a broker portfolio's positions come largest first with weights and totals over every position", async () => {
  const all = await collectionHoldingsHeadless.load(args(BROKER.id), context());
  // A holding without a quote has no market value and goes last, not first.
  expect(all.rows.map((row) => row.symbol)).toEqual(["MSFT", "NVDA", "TSLA", "AAPL", "1211"]);
  expect(all.errors).toEqual(["No market value or P&L for 1211; totals and weights leave them out."]);

  const result = await collectionHoldingsHeadless.load(args(BROKER.id, { limit: 3 }), context());

  expect(result.rows.map((row) => row.symbol)).toEqual(["MSFT", "NVDA", "TSLA"]);
  expect(result.rows[0]).toMatchObject({ shares: 30, price: 400, marketValue: 12_000, unrealizedPnl: 3_000, priceCurrency: "USD" });
  // A short is negative exposure and weighs against the net total, as `portfolio show` weighs it.
  expect(result.rows[2]).toMatchObject({ shares: -20, marketValue: -5_000, unrealizedPnl: 1_000 });
  expect(result.rows[0]!.weight).toBeCloseTo((12_000 / 19_000) * 100, 8);
  expect(result.rows[2]!.weight).toBeCloseTo((-5_000 / 19_000) * 100, 8);
  expect(result.metadata).toMatchObject({
    collection: { kind: "portfolio", id: BROKER.id, broker: true },
    currency: "USD",
    positions: 5,
    totals: { marketValue: 19_000, grossMarketValue: 29_000, unrealizedPnl: 9_500 },
    notices: [
      "2 more positions not shown; totals include every position.",
      // No account was synced here, so the total weighs only the positions.
      expect.stringContaining("cash and margin are unknown"),
    ],
  });
});

test("every column PF declares is a field of its position rows, the listing included", async () => {
  // Ask Gloom's scripts read rows by the declared keys: a declared key the rows
  // lack reads undefined, and an undeclared field is never printed (a turn took
  // two European holdings for their US listings).
  const keys = (collectionHoldingsHeadless.columns ?? []).map((column) => column.key);
  expect(keys).toContain("exchange");
  const result = await collectionHoldingsHeadless.load(args(BROKER.id), context());
  expect(result.rows.length).toBeGreaterThan(0);
  for (const row of result.rows) {
    for (const key of keys) expect(row).toHaveProperty(key);
  }
  expect(result.rows[0]).toMatchObject({ exchange: "NASDAQ" });
});

test("a watchlist reads by name, and an unknown id lists the ones that exist", async () => {
  const watchlist = await collectionHoldingsHeadless.load(args("tech"), context());
  expect(watchlist.rows).toEqual([{ symbol: "SPY", name: "SPDR S&P 500", exchange: "NASDAQ", price: 500, priceCurrency: "USD", changePercent: 1.5, stale: false, updatedAt: expect.any(Number) }]);
  expect(watchlist.metadata).toMatchObject({ collection: { kind: "watchlist", id: "tech" }, tickers: 1 });

  await expect(collectionHoldingsHeadless.load(args("default"), context()))
    .rejects.toThrow(`Unknown portfolio or watchlist "default". IDs: main, ${BROKER.id}, tech.`);
});
