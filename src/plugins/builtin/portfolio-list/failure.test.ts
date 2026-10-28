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
