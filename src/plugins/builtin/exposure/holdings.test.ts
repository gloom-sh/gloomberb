import { expect, test } from "bun:test";
import { createTestTicker } from "../../../test-support/ticker";
import { createTestQuote } from "../../../test-support/data-provider";
import type { Portfolio } from "../../../types/ticker";
import { portfolioHoldings, watchlistHoldings } from "./holdings";

const portfolio: Portfolio = { id: "test", name: "Account", currency: "USD" };
const ticker = (symbol: string, shares: number, currency = "USD") => createTestTicker(symbol, symbol, { currency, portfolios: ["test"], positions: [{ portfolio: "test", shares, currency, broker: "manual", avgCost: 9 }] });
test("portfolio valuation uses signed current market value, FX and explicit NAV, with no net normalization", async () => {
  const long = ticker("LONG", 10, "EUR"), short = ticker("SHORT", 5);
  short.metadata.positions[0]!.side = "short";
  const values = await portfolioHoldings(portfolio, [long, short], 500, {
    getQuote: async symbol => createTestQuote({ price: 10, currency: symbol === "LONG" ? "EUR" : "USD" }),
    getExchangeRate: async () => 1.25,
  });
  expect(values.map(h => h.weight)).toEqual([.25, -.1]);
  expect(values.reduce((sum, h) => sum + h.weight, 0)).toBeCloseTo(.15);
});
test("missing NAV or valuation never turns a partial portfolio into an equal weighted basket", async () => {
  const market = { getQuote: async () => { throw new Error("offline"); }, getExchangeRate: async () => 1 };
  await expect(portfolioHoldings(portfolio, [ticker("A", 5)], 0, market)).rejects.toThrow("positive NAV");
  await expect(portfolioHoldings(portfolio, [ticker("A", 5)], 100, market)).rejects.toThrow("Market value unavailable");
  const option = ticker("OPT", 1); option.metadata.assetCategory = "OPT";
  await expect(portfolioHoldings(portfolio, [option], 100, market)).rejects.toThrow("underlying exposure");
});
test("broker marked shorts retain their sign when live quotes are unavailable", async () => {
  const short = ticker("SHORT", -2); short.metadata.positions[0]!.marketValue = 80;
  const holdings = await portfolioHoldings(portfolio, [short], 400, { getQuote: async () => { throw new Error("offline"); }, getExchangeRate: async () => 1 });
  expect(holdings[0]!.weight).toBe(-.2);
});
test("watchlist membership uses equal weights only within that watchlist", () => {
  const a = ticker("A", 1), b = ticker("B", 2); a.metadata.watchlists = ["w"]; b.metadata.watchlists = ["other"];
  expect(watchlistHoldings([a, b], "w")).toEqual([{ symbol: "A:XNAS", weight: 1 }]);
});
test("minor-unit broker marks and normalized live quotes use their independent currency units", async () => {
  const pence = ticker("UK", 2, "GBp"); pence.metadata.positions[0]!.marketValue = 80;
  const requested: string[] = [];
  const market = { getQuote: async () => { throw new Error("offline"); }, getExchangeRate: async (currency: string) => { requested.push(currency); return 1.25; } };
  const snapshot = await portfolioHoldings(portfolio, [pence], 400, market);
  expect(requested).toEqual(["GBP"]);
  expect(snapshot[0]!.weight).toBeCloseTo(.0025);
  const live = await portfolioHoldings(portfolio, [pence], 400, { ...market, getQuote: async () => createTestQuote({ price: .4, currency: "GBP" }) });
  expect(live[0]!.weight).toBeCloseTo(.0025);
});
