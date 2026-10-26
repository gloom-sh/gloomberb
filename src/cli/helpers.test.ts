import { afterEach, beforeEach, expect, test } from "bun:test";
import { getRegularSessionDisplay } from "../market-data/market/status";
import { quoteFormatOptions } from "../market-data/market/format";
import { createTestQuote } from "../test-support/data-provider";
import type { Quote } from "../types/financials";
import { setCliColorEnabledOverride } from "../utils/cli-output";
import { quoteChangeText } from "./helpers";

beforeEach(() => setCliColorEnabledOverride(false));
afterEach(() => setCliColorEnabledOverride(null));

/** Wed 21 Oct 2026: dates this year read without it. */
const NOW = Date.parse("2026-10-21T01:30:00Z");
const change = (quote: Quote, terms?: Parameters<typeof quoteChangeText>[3]) =>
  quoteChangeText(quote, getRegularSessionDisplay(quote)!, quoteFormatOptions(quote), terms, NOW);

const coffee = createTestQuote({
  symbol: "KC=F", currency: "USX", instrumentType: "FUTURE", listingExchangeName: "ICE FUTURES", exchangeName: "ICE FUTURES",
  marketState: "REGULAR", price: 316, change: 1.05, changePercent: 0.333, previousClose: 314.95, changeSessionDate: "2026-10-19", lastUpdated: Date.parse("2026-10-19T14:00:00Z"),
});
const fridaySettled = { settlement: { price: 314.95, date: "2026-10-16" }, spec: { tick: 0.05 } };

test("the Change line of quote and ticker says what a future's move is from, in the quote's own unit", () => {
  expect(change(coffee, fridaySettled)).toBe("+1.05¢ (+0.33%) vs Fri 16 Oct settle");
  // Before the open the line is still Friday's move, so its reference is Thursday's, not Friday's.
  const preMarket = { ...coffee, marketState: "PRE" as const, price: 314.95, change: 2.55, changePercent: 0.816,
    regularClose: 314.95, regularChange: 2.55, regularChangePercent: 0.816, regularCloseSessionDate: "2026-10-16",
    lastUpdated: Date.parse("2026-10-16T17:30:00Z") };
  expect(change(preMarket, { ...fridaySettled, settlement: { price: 312.4, date: "2026-10-15" } })).toBe("+2.55¢ (+0.82%) vs Thu 15 Oct settle");
  // No settlement to check against: the session before's close.
  expect(change(coffee, { settlement: null, spec: { tick: 0.05 } })).toBe("+1.05¢ (+0.33%) vs Fri 16 Oct close");
});

// 3042.HK read -0.60% on Tue 20 Oct with no date: HKEX had been shut Mon 19 Oct.
test("every move says the close it is from, with the venue's holidays since on the line under it", () => {
  const stock = createTestQuote({ symbol: "AAPL", currency: "USD", price: 251.5, change: -1.5, changePercent: -0.593, changeSessionDate: "2026-10-19",
    listingExchangeName: "NASDAQ", lastUpdated: Date.parse("2026-10-19T20:00:00Z") });
  expect(change(stock)).toBe("-$1.50 (-0.59%) vs Fri 16 Oct close");
  const hk = createTestQuote({ symbol: "3042.HK", currency: "HKD", price: 9.88, change: -0.06, changePercent: -0.6, previousClose: 9.94,
    changeSessionDate: "2026-10-20", listingExchangeName: "HKEX", lastUpdated: Date.parse("2026-10-20T08:08:00Z") });
  expect(change(hk)).toBe("-HK$0.06 (-0.60%) vs Fri 16 Oct close\nHKEX closed Mon 19 Oct, holiday");
  // A future without terms: the session before's close, unchecked against a settlement.
  expect(change(coffee, null)).toBe("+1.05¢ (+0.33%) vs Fri 16 Oct close");
});

test("a listing that no longer trades has no move to give, whatever its last quote carried", () => {
  const twitter = createTestQuote({ symbol: "TWTR", currency: "USD", price: 53.7, change: 0.51, changePercent: 0.96,
    delisting: { status: "delisted", lastTradeDate: "2022-10-27", historyStart: "2016-01-04" } });
  expect(change(twitter)).toBe("—");
});
