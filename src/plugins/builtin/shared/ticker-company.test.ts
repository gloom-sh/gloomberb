import { expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { looksLikeTicker, tickerCompanyName } from "./ticker-company";

const quotes: Record<string, Partial<Quote>> = {
  VKTX: { name: "Viking Therapeutics, Inc.", instrumentType: "EQUITY" },
  PHAR: { name: "Pharming Group N.V.", instrumentType: "Depositary Receipt" },
  QQQ: { name: "Invesco QQQ Trust, Series 1", instrumentType: "ETF" },
};
const provider = { getQuote: async (symbol: string) => {
  const quote = quotes[symbol];
  if (!quote) throw new Error(`No quote for ${symbol}`);
  return { symbol, price: 1, currency: "USD", change: 0, changePercent: 0, lastUpdated: 0, ...quote } as Quote;
} };

// `TRIAL VKTX` and `FDA AZN` found nothing, since the registries file records by company name.
test("a ticker reads as its company's name; a fund or an unknown symbol names no company", async () => {
  expect(await tickerCompanyName(provider, "vktx")).toBe("Viking Therapeutics");
  expect(await tickerCompanyName(provider, "PHAR")).toBe("Pharming Group");
  expect(await tickerCompanyName(provider, "QQQ")).toBeNull();
  expect(await tickerCompanyName(provider, "ZZZZ")).toBeNull();
  expect(await tickerCompanyName(null, "VKTX")).toBeNull();
  expect(["VKTX", "brk.b", "F"].map(looksLikeTicker)).toEqual([true, true, true]);
  expect(["Viking Therapeutics", "semaglutide", "NCT07846033"].map(looksLikeTicker)).toEqual([false, false, false]);
});
