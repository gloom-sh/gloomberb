import { expect, test } from "bun:test";
import type { CloudQuotePayload } from "../../api-client";
import { mapQuote } from "../../sources/gloomberb-cloud/normalizers";
import type { Quote } from "../../types/financials";
import { exchangeRateMetadata } from "../../utils/exchange-rate-snapshot";
import { fxRateNotes } from "../../plugins/builtin/shared/fx-rate-freshness";
import { mergeQuoteContribution, normalizeQuoteContribution } from "./contributions";
import { quoteBarNotes } from "./intraday-bar";

// Fri 23 Oct 2026: BRLUSD=X printed nothing from 03:20 UTC while USD/BRL's five-minute bars ran on.
const now = Date.parse("2026-10-23T06:53:00Z");
const bar = { start: Date.parse("2026-10-23T06:30:00Z"), minutes: 5 };
const noNewer = "no newer bar yet";
const served: CloudQuotePayload = {
  symbol: "USDBRL=X", currency: "BRL", price: 5.05139, previousClose: 5.04, lastUpdated: Date.parse("2026-10-23T06:35:00Z"),
  exchangeName: "CCY", providerId: "gloomberb-cloud", dataSource: "delayed", stale: false, intradayBar: bar,
};

test("a pair's price from its bar says which bar, with no last trade carried over from the print before it", () => {
  const quote = mapQuote(served);
  expect(quote.intradayBar).toEqual(bar);
  expect(quoteBarNotes("USDBRL=X", quote, now)).toEqual([
    "USDBRL=X: 06:30–06:35 UTC bar close, quotes paused",
  ]);
  // A field that is not a bar's, or a blank reason, is dropped rather than shown.
  for (const intradayBar of [{ start: "06:30", minutes: 5 }, { start: bar.start, minutes: 0 }, null, 5]) {
    const mapped = mapQuote({ ...served, intradayBar, staleReason: " " } as unknown as CloudQuotePayload);
    expect([mapped.intradayBar, mapped.staleReason]).toEqual([undefined, undefined]);
  }
  const print = normalizeQuoteContribution({ ...mapQuote({ ...served, intradayBar: undefined }), price: 5.0523,
    lastUpdated: Date.parse("2026-10-23T03:20:00Z"), lastTradePrice: 5.0523, lastTradeTime: Date.parse("2026-10-23T03:20:00Z") })!;
  const merged = mergeQuoteContribution(print, normalizeQuoteContribution(mapQuote(served))!);
  expect(merged).toMatchObject({ price: 5.05139, intradayBar: bar });
  expect([merged.lastTradePrice, merged.lastTradeTime]).toEqual([undefined, undefined]);
  // The next print says nothing of a bar: it is a print again.
  expect(mergeQuoteContribution(merged, print).intradayBar).toBeUndefined();
});

test("a stale pair print says why it stands, and only while it reads stale", () => {
  const quote: Quote = { ...mapQuote({ ...served, intradayBar: undefined, staleReason: noNewer, stale: true }), price: 5.0523 };
  expect(quote.staleReason).toBe(noNewer);
  expect(quoteBarNotes("USDBRL=X", quote, now)).toEqual([`USDBRL=X: ${noNewer}`]);
  expect(quoteBarNotes("USDBRL=X", { ...quote, stale: false, lastUpdated: now - 60_000 }, now)).toEqual([]);
});

test("an exchange rate carries its bar and its reason to the fx lines, and a failed refresh states its own", () => {
  const rate = { fromCurrency: "BRL", toCurrency: "USD", rate: 1 / 5.05139, asOf: "2026-10-23T06:35:00.000Z",
    fetchedAt: "2026-10-23T06:52:00.000Z", stale: false, delayMinutes: 15, intradayBar: bar };
  expect(exchangeRateMetadata(rate, "BRL", now)).toMatchObject({ intradayBar: bar, delayMinutes: 15 });
  expect(exchangeRateMetadata({ ...rate, intradayBar: { start: bar.start } }, "BRL", now).intradayBar).toBeUndefined();
  expect(fxRateNotes(new Map([["USD", {}], ["BRL", exchangeRateMetadata(rate, "BRL", now)]]), now)).toEqual([
    "BRL/USD: 06:30–06:35 UTC bar close, quotes paused",
  ]);
  const stale = exchangeRateMetadata({ ...rate, intradayBar: undefined, asOf: "2026-10-23T03:20:00.000Z", stale: true, staleReason: noNewer }, "BRL", now);
  expect(fxRateNotes(new Map([["BRL", stale]]), now)).toEqual([`BRL/USD: ${noNewer}`]);
  expect(fxRateNotes(new Map([["BRL", { ...stale, error: new Error("offline") }]]), now)).toEqual([]);
  expect(fxRateNotes(new Map([["BRL", { ...stale, staleAt: now + 60_000 }]]), now)).toEqual([]);
});
