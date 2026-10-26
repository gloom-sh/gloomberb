import { expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { looksLikeTicker } from "./model";
import { tickerSponsorName } from "./ticker-sponsor";

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

// `TRIAL VKTX` found nothing, since the registry files studies by sponsor name.
test("a ticker reads as its company's name; a fund or an unknown symbol names no sponsor", async () => {
  expect(await tickerSponsorName(provider, "vktx")).toBe("Viking Therapeutics");
  expect(await tickerSponsorName(provider, "PHAR")).toBe("Pharming Group");
  expect(await tickerSponsorName(provider, "QQQ")).toBeNull();
  expect(await tickerSponsorName(provider, "ZZZZ")).toBeNull();
  expect(await tickerSponsorName(null, "VKTX")).toBeNull();
  expect(["VKTX", "brk.b", "F"].map(looksLikeTicker)).toEqual([true, true, true]);
  expect(["Viking Therapeutics", "semaglutide", "NCT07846033"].map(looksLikeTicker)).toEqual([false, false, false]);
});
