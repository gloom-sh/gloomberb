import { expect, test } from "bun:test";
import type { InstrumentSearchResult } from "../types/instrument";
import type { QuoteSubscriptionTarget } from "../types/data-provider";
import { createTestQuote } from "../test-support/data-provider";
import { readNameEntries, readPhraseArgument } from "./name-entries";
import { quotedPhrase, splitSymbolArgs } from "./symbol-args";

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

test("one quoted argument with spaces is a company, a line of tickers, or a phrase never quoted word by word", async () => {
  expect(quotedPhrase(["10 year yield"])).toBe("10 year yield");
  expect(quotedPhrase([` "AAPL  MSFT" `])).toBe("AAPL MSFT");
  // Several arguments, one word, or a list with commas split as they always did.
  expect([["AAPL", "MSFT"], ["AAPL"], ["AAPL,MSFT"], ["AAPL, Apple Inc"]].map(quotedPhrase)).toEqual([null, null, null, null]);

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
