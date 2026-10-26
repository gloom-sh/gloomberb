import { expect, test } from "bun:test";
import type { InstrumentSearchResult } from "../types/instrument";
import type { QuoteSubscriptionTarget } from "../types/data-provider";
import { createTestQuote } from "../test-support/data-provider";
import { readNameEntries, readPhraseArgument } from "./name-entries";
import { quotedPhrase, splitSymbolArgs } from "./symbol-args";
import { ProviderBusyError } from "../sources/provider-errors";

test("an entry with spaces is a company's name when search finds one, else the symbols it holds; a plain symbol costs no search", async () => {
  const asked: string[] = [];
  const whirlpool: InstrumentSearchResult = { providerId: "test", symbol: "WHR", name: "Whirlpool Corp", exchange: "NYSE", currency: "USD", type: "Common Stock" };
  const search = async (query: string) => {
    asked.push(query);
    return /whirlpool/i.test(query) ? [whirlpool] : [];
  };
  const entries = splitSymbolArgs(["WHR, Whirlpool Corporation , brk.b bf-b\nAAPL"]);
  expect(await readNameEntries(entries, { search })).toEqual(["WHR", "Whirlpool Corporation", "brk.b", "bf-b", "AAPL"]);
  expect(asked.filter((query) => ["WHR", "AAPL"].includes(query))).toEqual([]);
  expect(asked).toContain("brk.b bf-b");
  // Quote marks around each word of a pasted line are dropped with the rest.
  expect(await readNameEntries(splitSymbolArgs([`"AAPL" "MSFT", NVDA`]), { search })).toEqual(["AAPL", "MSFT", "NVDA"]);
});

test("a pasted line search finds no company for is its words only when they are written as symbols or each has a quote", async () => {
  // A misspelt "phillip morris intl" added INTL, a fund, and its other words came back not found.
  const quoted = new Set(["AAPL", "MSFT", "INTL"]);
  const batches: string[][] = [];
  const provider = {
    search: async (): Promise<InstrumentSearchResult[]> => [],
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]) => {
      batches.push(targets.map(({ symbol }) => symbol));
      return targets.map((target) => quoted.has(target.symbol)
        ? { target, quote: createTestQuote({ symbol: target.symbol }) }
        : { target, quote: null, error: new Error(`Not a ticker: ${target.symbol}.`) });
    },
  };
  expect(await readNameEntries(["phillip morris intl", "aapl msft", "BRK.B bf-b", "2222 aapl"], provider))
    .toEqual(["phillip morris intl", "aapl", "msft", "BRK.B", "bf-b", "2222", "aapl"]);
  // Words written as symbols cost no quote.
  expect(batches.flat().sort()).toEqual(["AAPL", "AAPL", "INTL", "MORRIS", "MSFT", "PHILLIP"]);
});

test("one quoted argument with spaces is a company, a line of tickers, or a phrase never quoted word by word", async () => {
  expect(quotedPhrase(["10 year yield"])).toBe("10 year yield");
  expect(quotedPhrase([` "AAPL  MSFT" `])).toBe("AAPL MSFT");
  // Several arguments, one word, or a list with commas split as they always did.
  expect([["AAPL", "MSFT"], ["AAPL"], ["AAPL,MSFT"], ["AAPL, Apple Inc"]].map(quotedPhrase)).toEqual([null, null, null, null]);
  // A figure is part of a phrase; a pasted row of symbols, each with its prices, is a list.
  expect([["10.5 year yield"], ["ED 2.582,52"], ["AAPL 150.00 MSFT 300.00"]].map(quotedPhrase)).toEqual(["10.5 year yield", null, null]);

  const batches: string[][] = [];
  const tickers = new Set(["AAPL", "MSFT", "YEAR", "YIELD", "BRK.B"]);
  const provider = {
    search: async (query: string) => /whirlpool/i.test(query)
      ? [{ providerId: "test", symbol: "WHR", name: "Whirlpool Corp", exchange: "NYSE", currency: "USD", type: "Common Stock" }]
      : [],
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]) => {
      batches.push(targets.map(({ symbol }) => symbol));
      return targets.map((target) => tickers.has(target.symbol)
        ? { target, quote: createTestQuote({ symbol: target.symbol }) }
        : { target, quote: null, error: new Error(`Not a ticker: ${target.symbol}.`) });
    },
  };
  expect(await readPhraseArgument("10 year yield", provider)).toEqual({ kind: "phrase", phrase: "10 year yield" });
  // Every word in one request, not one each.
  expect(batches).toEqual([["10", "YEAR", "YIELD"]]);
  expect(await readPhraseArgument("aapl MSFT brk.b SAN:EPA", provider)).toEqual({ kind: "symbols", symbols: ["aapl", "MSFT", "brk.b", "SAN:EPA"] });
  expect(await readPhraseArgument("Whirlpool Corporation", provider)).toEqual({ kind: "name", name: "Whirlpool Corporation" });
  // A word the source could not answer for, as in an outage, is not taken as proof of a phrase.
  const down = { ...provider, getQuotesBatch: async (targets: QuoteSubscriptionTarget[]) => targets.map((target) => ({ target, quote: null, error: new Error("timeout") })) };
  expect(await readPhraseArgument("AAPL MSFT", down)).toEqual({ kind: "symbols", symbols: ["AAPL", "MSFT"] });
});

test("a Bloomberg code is one entry when search lists its root as a US ticker; words that only look like one are a name or their words", async () => {
  const listed: Record<string, InstrumentSearchResult[]> = {
    JPM: [{ providerId: "test", symbol: "JPM", name: "JPMorgan Chase & Co.", exchange: "NYSE", currency: "USD", type: "Common Stock" }],
    // GLOBAL trades only abroad.
    GLOBAL: [{ providerId: "test", symbol: "GLOBAL", name: "Global Holdings", exchange: "JSE", currency: "ZAR", type: "Common Stock" }],
  };
  const fund: InstrumentSearchResult = { providerId: "test", symbol: "PUEQX", name: "Putnam US Equity Fund", exchange: "NASDAQ", currency: "USD", type: "Mutual Fund" };
  const provider = {
    search: async (query: string) => listed[query] ?? (/putnam/i.test(query) ? [fund] : []),
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]) => targets.map((target) => ({ target, quote: null, error: new Error(`Not a ticker: ${target.symbol}.`) })),
  };
  expect(await readNameEntries(["JPM US Equity", "jpm us equity", "Putnam US Equity", "Global US Equity"], provider))
    .toEqual(["JPM US Equity", "jpm us equity", "Putnam US Equity", "Global US Equity"]);
  expect(await readPhraseArgument("jpm us equity", provider)).toEqual({ kind: "symbols", symbols: ["jpm us equity"] });
  expect(await readPhraseArgument("Putnam US Equity", provider)).toEqual({ kind: "name", name: "Putnam US Equity" });
  expect(await readPhraseArgument("Global US Equity", provider)).toEqual({ kind: "phrase", phrase: "Global US Equity" });
});

test("a name search too busy to answer is no answer: its words are not other companies' symbols, unless each has a quote", async () => {
  // Busy, "Eagle Bulk" was quoted as EAGLE, Eagle Filters in Helsinki, and BULK.
  const quoted = new Set(["EAGLE", "AAPL", "MSFT"]);
  const busy = {
    search: async (): Promise<InstrumentSearchResult[]> => { throw new ProviderBusyError(); },
    getQuotesBatch: async (targets: QuoteSubscriptionTarget[]) => targets.map((target) => quoted.has(target.symbol)
      ? { target, quote: createTestQuote({ symbol: target.symbol }) }
      : { target, quote: null, error: new Error(`No quote provider available for ${target.symbol}`) }),
  };
  await expect(readPhraseArgument("Eagle Bulk", busy)).rejects.toBeInstanceOf(ProviderBusyError);
  expect(await readPhraseArgument("AAPL MSFT", busy)).toEqual({ kind: "symbols", symbols: ["AAPL", "MSFT"] });
  // In a list it stays whole, for its own lookup to say search was busy, unless each word has a quote: a line of
  // tickers typed whole (`fn SIW "GME AMC"`) still reads, but capitals alone (BANK OF AMERICA) are no proof.
  expect(await readNameEntries(["AAPL", "Eagle Bulk", "aapl msft", "BANK OF AMERICA"], busy)).toEqual(["AAPL", "Eagle Bulk", "aapl", "msft", "BANK OF AMERICA"]);
});
