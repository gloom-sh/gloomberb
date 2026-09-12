import { expect, spyOn, test } from "bun:test";
import { AssetDataRouter } from "../../../sources/provider-router";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { Quote } from "../../../types/financials";
import { appendLiveQuotePoint } from "../../../time-series/chart-data";
import { quoteComparisonHeadless } from "./headless";

for (const routed of [false, true]) test(`QM ${routed ? "routed" : "direct"} exports reject invalid quote times without losing healthy peers and recover the actual observation`, async () => {
  const now = Date.parse("2026-09-12T03:01:00Z");
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const sourceTime = Date.parse("2026-09-11T23:59:00Z");
  const sourceQuote: Quote = Object.freeze({ symbol: "BAD", price: 59.786, currency: "USD", change: 0.486, changePercent: 0.81956,
    lastUpdated: sourceTime, listingExchangeName: "NASDAQGM", marketState: "POST", dataSource: "delayed" });
  let lastUpdated: number | null = NaN;
  const provider = createTestDataProvider({
    getQuote: async symbol => ({ ...sourceQuote, symbol, lastUpdated: symbol === "GOOD" ? sourceTime : lastUpdated as number }),
  });
  const context = { marketData: routed ? new AssetDataRouter(provider) : provider, config: createDefaultConfig("/tmp/quote-time-export-unused"), signal: new AbortController().signal } as any;
  const args = { symbols: ["BAD", "GOOD"], argument: ["BAD", "GOOD"], rawArgument: "BAD,GOOD", options: {} };
  try {
    for (const invalid of [NaN, Infinity, JSON.parse(JSON.stringify(NaN)), now + 60_000]) {
      lastUpdated = invalid;
      const model = await quoteComparisonHeadless.load(args, context);
      const serialized = JSON.parse(JSON.stringify(model));
      expect(serialized.rows.map((row: any) => row.symbol)).toEqual(["GOOD"]);
      expect(serialized.unavailableSymbols).toEqual(["BAD"]);
      expect(serialized.errors.length).toBe(1);
      const history = [{ date: new Date(sourceTime - 600_000), close: 59 }];
      expect(appendLiveQuotePoint(history, { ...sourceQuote, lastUpdated: invalid })).toBe(history);
    }
    lastUpdated = sourceTime;
    const recovered = await quoteComparisonHeadless.load(args, context);
    expect(recovered.rows.map(row => row.symbol)).toEqual(["BAD", "GOOD"]);
    expect(recovered.unavailableSymbols).toEqual([]);
    expect(recovered.rows[0]).toMatchObject({ price: 59.786, updatedAt: sourceTime, change: 0.486, currency: "USD" });
    const history = [{ date: new Date(sourceTime - 600_000), close: 59 }];
    const appended = appendLiveQuotePoint(history, sourceQuote);
    expect(appended.at(-1)).toMatchObject({ date: new Date(sourceTime), close: sourceQuote.price });
    expect(sourceQuote.lastUpdated).toBe(sourceTime);
  } finally { clock.mockRestore(); }
});
