import { expect, test } from "bun:test";
import { createProviderMiss, ProviderBusyError } from "../../../sources/provider-errors";
import type { Quote } from "../../../types/financials";
import { DataServiceUnreachableError } from "../../../utils/network-failure";
import { looksLikeTicker, tickerCompanyName } from "./ticker-company";

const quotes: Record<string, Partial<Quote>> = {
  VKTX: { name: "Viking Therapeutics, Inc.", instrumentType: "EQUITY" },
  PHAR: { name: "Pharming Group N.V.", instrumentType: "Depositary Receipt" },
  QQQ: { name: "Invesco QQQ Trust, Series 1", instrumentType: "ETF" },
};
const provider = { getQuote: async (symbol: string) => {
  const quote = quotes[symbol];
  // What the router says when no listing trades under a symbol.
  if (!quote) throw createProviderMiss(`Not a ticker: ${symbol}.`, undefined, { notFound: true });
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

// A quote that could not be read says nothing about the company: the search must not settle for none.
test("a quote that could not be read rejects rather than naming no company", async () => {
  for (const failure of [new DataServiceUnreachableError(new Error("offline")), new ProviderBusyError()]) {
    const failing = { getQuote: async () => { throw failure; } };
    await expect(tickerCompanyName(failing, "VKTX")).rejects.toBe(failure);
  }
});
