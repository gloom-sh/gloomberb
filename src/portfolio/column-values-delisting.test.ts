import { expect, test } from "bun:test";
import type { Quote, TickerFinancials } from "../types/financials";
import { colors } from "../theme/colors";
import { createTestTicker } from "../test-support/ticker";
import { calculatePortfolioSummaryTotals } from "../plugins/builtin/portfolio-list/summary/totals";
import { getColumnValue, getSortValue } from "./column-values";

const context = { activeTab: "main", baseCurrency: "USD", exchangeRates: new Map([["USD", 1]]), now: Date.parse("2026-10-20T15:00:00Z") };
const lastQuote: Quote = { symbol: "TWTR", price: 53.86, currency: "USD", change: 0.51, changePercent: 0.96,
  lastUpdated: Date.parse("2022-10-28T12:00:00Z"), dataSource: "delayed" };
const delisting = (status: "delisted" | "inactive") => ({ status, lastTradeDate: "2022-10-27", historyStart: "2016-01-04" });
const financials = (quote: Quote): TickerFinancials => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [], quote });
const column = (id: string) => ({ id, label: id, width: 9, align: "right" as const });

test("a watchlist row of a listing that no longer trades says so instead of a day's move", () => {
  const ticker = createTestTicker("TWTR", "Twitter, Inc.", { exchange: "NYSE" });
  for (const [status, text] of [["delisted", "DELISTED"], ["inactive", "INACTIVE"]] as const) {
    const data = financials({ ...lastQuote, delisting: delisting(status) });
    for (const id of ["change", "change_pct"]) {
      expect(getColumnValue(column(id), ticker, data, context)).toEqual({ text, color: colors.warning });
      expect(getSortValue(column(id), ticker, data, context)).toBeNull();
    }
  }
  // A listing still trading keeps its move.
  expect(getColumnValue(column("change_pct"), ticker, financials(lastQuote), context).text).toBe("+0.96%");
  expect(getSortValue(column("change_pct"), ticker, financials(lastQuote), context)).toBe(0.96);
});

test("a held listing that no longer trades is valued at its last price with no day's P&L", () => {
  const position = { portfolio: "main", broker: "manual", shares: 100, avgCost: 40, currency: "USD" };
  const twtr = createTestTicker("TWTR", "Twitter, Inc.", { exchange: "NYSE", portfolios: ["main"], positions: [position] });
  const aapl = createTestTicker("AAPL", "Apple Inc.", { portfolios: ["main"], positions: [position] });
  const aaplQuote: Quote = { symbol: "AAPL", price: 342, currency: "USD", change: 2, changePercent: 0.59, lastUpdated: context.now, dataSource: "delayed" };
  const delisted = financials({ ...lastQuote, delisting: delisting("delisted") });
  expect(getColumnValue(column("day_pnl"), twtr, delisted, context)).toEqual({ text: "DELISTED", color: colors.warning });
  expect(getSortValue(column("day_pnl"), twtr, delisted, context)).toBeNull();

  const map = new Map([["TWTR", delisted], ["AAPL", financials(aaplQuote)]]);
  const held = calculatePortfolioSummaryTotals([twtr, aapl], map, "USD", context.exchangeRates, true, "main");
  expect(held.totalMktValue).toBeCloseTo(100 * 53.86 + 100 * 342, 6);
  // AAPL's $2 a share is the day; TWTR's last session is not.
  expect(held.dailyPnl).toBeCloseTo(200, 6);

  // A watchlist's Avg Day is the mean of the CHG% it shows, which a delisted row has none of.
  const watched = calculatePortfolioSummaryTotals([twtr, aapl], map, "USD", context.exchangeRates, false, "watchlist");
  expect(watched.avgWatchlistChange).toBeCloseTo(0.59, 6);
});
