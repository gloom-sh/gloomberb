import { describe, expect, test } from "bun:test";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerPosition, TickerRecord } from "../../../types/ticker";
import { selectUpgradeTickers, upgradeTickerList } from "./upgrade-tickers";

function lot(shares: number, overrides: Partial<TickerPosition> = {}): TickerPosition {
  return { portfolio: "main", shares, broker: "manual", ...overrides };
}

function held(symbol: string, positions: TickerPosition[], overrides: Partial<TickerRecord["metadata"]> = {}): TickerRecord {
  return createTestTicker(symbol, symbol, { portfolios: ["main"], positions, ...overrides });
}

function quotes(prices: Record<string, number>): Map<string, TickerFinancials> {
  return new Map(Object.entries(prices).map(([symbol, price]) => [
    symbol,
    createTestFinancials({ quote: createTestQuote({ symbol, price }) }),
  ]));
}

describe("upgrade tickers", () => {
  test("names the three biggest holdings by market value, across portfolios", () => {
    const tickers = [
      held("AAPL", [lot(10)]),
      held("MSFT", [lot(5), lot(5, { portfolio: "ira" })]),
      held("NVDA", [lot(100)]),
      // A short is as big a position as a long.
      held("TSLA", [lot(-40, { side: "short" })]),
      held("AMD", [lot(1)]),
    ];
    const financials = quotes({ AAPL: 200, MSFT: 400, NVDA: 120, TSLA: 250, AMD: 100 });
    // NVDA 12,000; TSLA 10,000; MSFT 4,000 over two portfolios; AAPL 2,000.
    expect(selectUpgradeTickers(tickers, financials, [])).toEqual(["NVDA", "TSLA", "MSFT"]);
  });

  test("ranks holdings the device can value first, then the rest by what was paid", () => {
    const tickers = [
      held("AAPL", [lot(10)]),
      // Far more was paid for these, but the device has no value for them.
      held("PLTR", [lot(500, { avgCost: 20 })]),
      held("RKLB", [lot(100, { avgCost: 30 })]),
      // A broker's own market value counts as known.
      held("COST", [lot(2, { marketValue: 1_800 })]),
    ];
    expect(selectUpgradeTickers(tickers, quotes({ AAPL: 200 }), [])).toEqual(["AAPL", "COST", "PLTR"]);
  });

  test("skips cash, options, futures, crypto, mutual funds, OTC and foreign listings, and odd symbols", () => {
    const tickers = [
      held("BTC-USD", [lot(1)], { exchange: "CCC", assetCategory: "CRYPTO" }),
      held("AAPL 250117C00150000", [lot(2, { multiplier: 100 })], { assetCategory: "OPT" }),
      held("SPX", [lot(1, { multiplier: 100 })]),
      held("ES", [lot(1)], { exchange: "CME", assetCategory: "FUT" }),
      held("USD", [lot(5000)], { exchange: "", assetCategory: "CASH" }),
      held("SHOP", [lot(10)], { exchange: "TSX", currency: "CAD" }),
      held("SHOP.TO", [lot(10)], { exchange: "TSX", currency: "CAD" }),
      held("7203", [lot(100)], { exchange: "JPX", currency: "JPY" }),
      held("^GSPC", [lot(1)]),
      held("VFIAX", [lot(100)], { assetCategory: "MUTUALFUND" }),
      held("TCEHY", [lot(100)], { exchange: "OTC" }),
      held("BRK.B", [lot(1)], { exchange: "NYSE" }),
      held("VOO", [lot(1)], { exchange: "NYSEARCA", assetCategory: "ETF" }),
    ];
    const financials = quotes({ "BRK.B": 450, VOO: 500 });
    expect(selectUpgradeTickers(tickers, financials, [])).toEqual(["VOO", "BRK.B"]);
  });

  test("with nothing held, takes watchlist tickers in list order, never a seeded or team name", () => {
    const watchlists = [
      { id: "team", name: "Desk", teamId: "acme" },
      { id: "starter", name: "Watchlist" },
      { id: "mine", name: "Picks" },
    ];
    const tickers = [
      createTestTicker("ZZZ", "Team pick", { watchlists: ["team"] }),
      ...["AAPL", "MSFT", "NVDA", "SPY"].map((symbol) => createTestTicker(symbol, symbol, { watchlists: ["starter", "mine"] })),
      createTestTicker("RKLB", "Added to the starter list", { watchlists: ["starter"] }),
      createTestTicker("ETH-USD", "Crypto", { watchlists: ["mine"], exchange: "CCC", assetCategory: "CRYPTO" }),
      createTestTicker("COST", "Costco", { watchlists: ["mine"] }),
      createTestTicker("AMD", "AMD", { watchlists: ["mine"] }),
    ];
    expect(selectUpgradeTickers(tickers, new Map(), watchlists)).toEqual(["RKLB", "AMD", "COST"]);
    // The untouched starter list alone names nothing.
    expect(selectUpgradeTickers(tickers.slice(1, 5), new Map(), watchlists)).toEqual([]);
  });

  test("names nothing without a usable holding or watchlist ticker", () => {
    expect(selectUpgradeTickers([], new Map(), [{ id: "watchlist", name: "Watchlist" }])).toEqual([]);
    expect(selectUpgradeTickers([held("BTC-USD", [lot(1)], { exchange: "CCC" })], new Map(), [])).toEqual([]);
    // In a portfolio with no shares left: followed, not held.
    expect(selectUpgradeTickers([held("HOOD", [lot(0)])], new Map(), [])).toEqual([]);
  });

  test("joins one, two or three names", () => {
    expect(upgradeTickerList(["NVDA"])).toBe("NVDA");
    expect(upgradeTickerList(["NVDA", "AAPL"])).toBe("NVDA and AAPL");
    expect(upgradeTickerList(["NVDA", "AAPL", "MSFT"])).toBe("NVDA, AAPL and MSFT");
  });
});
