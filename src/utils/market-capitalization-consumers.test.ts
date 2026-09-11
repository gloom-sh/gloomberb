import { expect, test } from "bun:test";
import type { TickerRecord } from "../types/ticker";
import type { TickerFinancials } from "../types/financials";
import { getColumnValue, getSortValue } from "../plugins/builtin/portfolio-list/column-values";
import { buildTrackedCurrencies } from "../plugins/builtin/portfolio-list/pane/data";
import { buildOverviewStats } from "../plugins/builtin/ticker-detail/overview/model";

const ticker: TickerRecord = { metadata: { ticker: "F:XNYS", name: "Ford", exchange: "NYSE", currency: "USD",
  portfolios: [], watchlists: [], positions: [], custom: {}, tags: [] } };
const column = { id: "market_cap", label: "MCAP", width: 12, align: "right" as const };
const fundamentals = { marketCap: 100, marketCapCurrency: "EUR", financialCurrency: "USD", freeCashFlow: -20,
  source: "yahoo" as const, fetchedAt: "2026-09-11T15:23:57Z" };
const makeFinancials = (extra: Partial<TickerFinancials> = {}): TickerFinancials => ({
  annualStatements: [], quarterlyStatements: [], priceHistory: [], fundamentals, ...extra,
});
const context = { baseCurrency: "GBP", exchangeRates: new Map([["EUR", 1.2], ["GBP", 2]]), now: 1 };
const overview = (data: TickerFinancials, rates = context.exchangeRates) => buildOverviewStats({
  quote: data.quote, fundamentals: data.fundamentals, quoteCurrency: "USD", baseCurrency: "GBP",
  toBase: () => { throw new Error("Market cap must not use a quote-currency conversion"); }, marketCapExchangeRates: rates,
});

test("overview and portfolio use the cap's explicit currency when a quote has no capitalization", () => {
  const data = makeFinancials({ quote: { symbol: "F:XNYS", currency: "USD", price: 14, change: 0, changePercent: 0, lastUpdated: 1 } });
  expect(getColumnValue(column, ticker, data, context).text).toBe("60");
  expect(getSortValue(column, ticker, data, context)).toBe(60);
  expect(overview(data).find(({ label }) => label === "Market Cap")?.value).toBe("60 GBP");
  expect(data.quote?.marketCap).toBeUndefined();
  expect(data.fundamentals).toEqual(fundamentals);
});

test("fundamental caps remain available without reviving any price quote", () => {
  const data = makeFinancials();
  expect(getColumnValue(column, ticker, data, context).text).toBe("60");
  expect(getSortValue(column, ticker, data, context)).toBe(60);
  expect(overview(data).find(({ label }) => label === "Market Cap")?.value).toBe("60 GBP");
  expect(data.quote).toBeUndefined();
});

test("missing FX never creates a comparable 1:1 market cap; overview retains explicit original units", () => {
  const data = makeFinancials(); const exchangeRates = new Map<string, number>();
  expect(getColumnValue(column, ticker, data, { ...context, exchangeRates }).text).toBe("—");
  expect(getSortValue(column, ticker, data, { ...context, exchangeRates })).toBeNull();
  expect(overview(data, exchangeRates).find(({ label }) => label === "Market Cap")?.value).toBe("100 EUR");
  expect(buildTrackedCurrencies([ticker], new Map([[ticker.metadata.ticker, data]]), null, "GBP")).toContain("EUR");
});

test("a valid quote cap keeps precedence and its own currency", () => {
  const data = makeFinancials({ quote: { symbol: "F:XNYS", currency: "USD", marketCap: 200, price: 14, change: 0, changePercent: 0, lastUpdated: 1 } });
  expect(getColumnValue(column, ticker, data, context).text).toBe("100");
  expect(getSortValue(column, ticker, data, context)).toBe(100);
  expect(overview(data).find(({ label }) => label === "Market Cap")?.value).toBe("100 GBP");
});

test("ticker and statement currencies cannot fill a missing capitalization currency", () => {
  const data = makeFinancials({ fundamentals: { ...fundamentals, marketCapCurrency: undefined } });
  expect(getColumnValue(column, ticker, data, context).text).toBe("—");
  expect(getSortValue(column, ticker, data, context)).toBeNull();
  expect(overview(data).some(({ label }) => label === "Market Cap")).toBe(false);
});
