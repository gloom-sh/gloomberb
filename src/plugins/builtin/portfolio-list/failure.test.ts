import { expect, spyOn, test } from "bun:test";
import { createTestTicker } from "../../../test-support/ticker";
import type { Quote } from "../../../types/financials";
import { debugLog } from "../../../utils/debug-log";
import { loadCollectionQuotes } from "./cli/render";

test("a rejected collection quote leaves the other tickers quoted and logs no rejection details", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "portfolio-list.cli.render") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const quote = { symbol: "OTHER", price: 100 } as Quote;
    const quotes = await loadCollectionQuotes([createTestTicker("ACME"), createTestTicker("OTHER")], { kind: "watchlist", id: "fixture" }, {
      getQuote: async (symbol) => {
        if (symbol === "ACME") throw new Error("token=private position=private");
        return quote;
      },
    });
    expect([...quotes]).toEqual([["OTHER", quote]]);
    expect(logged).toEqual([["warn", expect.stringMatching(/^Load collection quote failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});

test("a watchlist's quotes are asked in one batch, matched by listing rather than order, and one the batch left out is asked alone", async () => {
  const batches: string[][] = [];
  const singles: string[] = [];
  const quote = (symbol: string) => ({ symbol, price: 1 }) as Quote;
  const tickers = [createTestTicker("ACME"), createTestTicker("OTHER"), createTestTicker("LEFT")];
  const quotes = await loadCollectionQuotes(tickers, { kind: "watchlist", id: "fixture" }, {
    getQuotesBatch: async (targets) => {
      batches.push(targets.map((target) => target.symbol));
      // Answered out of order, and without LEFT.
      return [{ target: targets[1]!, quote: quote("OTHER") }, { target: targets[0]!, quote: quote("ACME") }];
    },
    getQuote: async (symbol) => {
      singles.push(symbol);
      return quote(symbol);
    },
  });
  expect(batches).toEqual([["ACME", "OTHER", "LEFT"]]);
  expect(singles).toEqual(["LEFT"]);
  expect([...quotes].map(([symbol, entry]) => [symbol, entry.symbol])).toEqual([["ACME", "ACME"], ["OTHER", "OTHER"], ["LEFT", "LEFT"]]);
});
