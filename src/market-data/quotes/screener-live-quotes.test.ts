import { describe, expect, test } from "bun:test";
import type { Quote } from "../../types/financials";
import { buildQuoteKey } from "../selectors";
import type { QueryEntry } from "../result-types";
import {
  buildScreenerQuoteTargets,
  overlayScreenerQuoteEntries,
  resolveScreenerQuoteFeedStatus,
} from "./screener-live-quotes";

function readyEntry(quote: Quote): QueryEntry<Quote> {
  return {
    phase: "ready",
    data: quote,
    lastGoodData: quote,
    source: "gloomberb-cloud",
    fetchedAt: quote.receivedAt ?? null,
    staleAt: null,
    error: null,
    attempts: [],
  };
}

describe("screener live quotes", () => {
  test("overlays dynamic quote fields without replacing screener metadata", () => {
    const rows = [{
      symbol: "AAPL",
      name: "Apple Inc.",
      price: 190,
      change: 1,
      changePercent: 0.5,
      volume: 10,
      currency: "USD",
      exchange: "NASDAQ",
      lastUpdated: 100,
      size: 3_000_000_000_000,
    }];
    const quote: Quote = {
      symbol: "AAPL",
      price: 192,
      change: 3,
      changePercent: 1.59,
      volume: 20,
      currency: "USD",
      lastUpdated: 200,
      dataSource: "live",
    };
    const entries = new Map([
      [buildQuoteKey({ symbol: "AAPL", exchange: "NASDAQ" }), readyEntry(quote)],
    ]);

    expect(overlayScreenerQuoteEntries(rows, entries)[0]).toMatchObject({
      name: "Apple Inc.",
      price: 192,
      changePercent: 1.59,
      volume: 20,
      size: 3_000_000_000_000,
    });
  });

  test("marks complete fresh Cloud stream coverage as live", () => {
    const now = 1_000;
    const rows = [
      { symbol: "AAPL", exchange: "NASDAQ" },
      { symbol: "MSFT", exchange: "NASDAQ" },
    ];
    const targets = buildScreenerQuoteTargets(rows, "AAPL");
    const entries = new Map<string, QueryEntry<Quote>>();
    for (const row of rows) {
      const quote: Quote = {
        symbol: row.symbol,
        price: 200,
        change: 1,
        changePercent: 0.5,
        currency: "USD",
        lastUpdated: now,
        receivedAt: now,
        delivery: "stream",
        stale: false,
        dataSource: "live",
      };
      entries.set(buildQuoteKey(row), readyEntry(quote));
    }

    expect(targets[0]).toMatchObject({ selected: true, weight: 100 });
    expect(resolveScreenerQuoteFeedStatus(targets, entries, {
      now,
      subscriptionStartedAt: 900,
    })).toBe("live");
  });

  test("reports nothing while the stream is still connecting", () => {
    const targets = buildScreenerQuoteTargets([{ symbol: "AAPL", exchange: "NASDAQ" }], null);
    const entries = new Map<string, QueryEntry<Quote>>();
    expect(resolveScreenerQuoteFeedStatus(targets, entries, { now: 1_000, subscriptionStartedAt: 900 })).toBeNull();
    expect(resolveScreenerQuoteFeedStatus(targets, entries, { now: 60_000, subscriptionStartedAt: 900 })).toBe("polling");
  });
});

test("replacement snapshots clear unavailable fields, keep the listing currency and select only the qualified listing", () => {
  const rows = [{ symbol: "ACME", exchange: "NASDAQ", name: "US", currency: "USD", price: 10, change: 1, changePercent: 10, volume: 200, lastUpdated: 100 },
    { symbol: "ACME", exchange: "LSE", name: "UK", currency: "GBP", price: 8, change: 0, changePercent: 0, volume: 0, lastUpdated: 100 }];
  const targets = buildScreenerQuoteTargets(rows, "ACME:XLON");
  expect(targets.map(target => target.selected)).toEqual([false, true]);
  const entries = new Map([[buildQuoteKey(rows[0]!), readyEntry({ symbol: "ACME", price: 12, currency: "", lastUpdated: 200 })]]);
  expect(overlayScreenerQuoteEntries(rows, entries)).toEqual([
    expect.objectContaining({ price: 12, change: null, changePercent: null, volume: null, currency: "USD", lastUpdated: 200 }), rows[1]!,
  ]);
  entries.set(buildQuoteKey(rows[0]!), readyEntry({ symbol: "ACME", price: 12, currency: "USD", lastUpdated: 50, change: 0, changePercent: 0, volume: 0 }));
  expect(overlayScreenerQuoteEntries(rows, entries)).toEqual(rows);
});

test("a board that follows extended sessions colors by the after-hours move from the close, and by the day once trading ends", () => {
  const rows = [{ symbol: "SPCX", exchange: "NASDAQ", name: "SpaceX", currency: "USD", price: 164.58, change: 0, changePercent: -1.8, volume: 1, lastUpdated: 100 }];
  const afterHours: Quote = { symbol: "SPCX", currency: "USD", price: 165.39, change: -2.21, changePercent: -1.3186,
    previousClose: 167.6, regularClose: 160.57, regularCloseSessionDate: "2026-10-08", changeSessionDate: "2026-10-08",
    marketState: "POST", postMarketPrice: 165.39, postMarketChange: 4.82, postMarketChangePercent: 3.0018,
    listingExchangeName: "NASDAQ", lastUpdated: Date.parse("2026-10-08T22:30:00Z") };
  const entries = new Map([[buildQuoteKey(rows[0]!), readyEntry(afterHours)]]);

  const [live] = overlayScreenerQuoteEntries(rows, entries, { extendedSessions: true });
  expect(live).toMatchObject({ price: 165.39, extendedSession: "POST" });
  expect(live!.changePercent).toBeCloseTo(3.0018, 3);
  // Without the option a row keeps the live price against the previous close.
  expect(overlayScreenerQuoteEntries(rows, entries)[0]).toMatchObject({ price: 165.39, changePercent: -1.3186 });
  expect(overlayScreenerQuoteEntries(rows, entries)[0]).not.toHaveProperty("extendedSession");

  // After 20:00 New York the session is over: the tile shows the regular session's close and move.
  entries.set(buildQuoteKey(rows[0]!), readyEntry({ ...afterHours, marketState: "POSTPOST", postMarketPrice: undefined,
    postMarketChange: undefined, postMarketChangePercent: undefined }));
  const [closed] = overlayScreenerQuoteEntries(rows, entries, { extendedSessions: true });
  expect(closed).toMatchObject({ price: 160.57, extendedSession: undefined });
  expect(closed!.changePercent).toBeCloseTo(-4.1945, 3);
});

describe("a heat map board outside the regular session", () => {
  // The snapshot is the last completed session's close and move; only a streamed name can show more.
  const tile = (symbol: string, price: number, change: number, changePercent: number) => ({
    symbol, exchange: "NASDAQ", name: symbol, currency: "USD", price, change, changePercent, volume: 1, regularChangePercent: changePercent,
  });
  const rows = [tile("SPCX", 160.57, -7.03, -4.1945), tile("NVDA", 230.48, -6.99, -2.9435), tile("AAPL", 340.42, 3.75, 1.1139)];
  const entriesFor = (quotes: Quote[]) => new Map(quotes.map((quote) => [buildQuoteKey({ symbol: quote.symbol, exchange: "NASDAQ" }), readyEntry(quote)]));
  const overlay = (quotes: Quote[]) => overlayScreenerQuoteEntries(rows, entriesFor(quotes), { extendedSessions: true });

  test("in the pre-market a name with a print shows it from the close, marked; the others keep the snapshot unmarked", () => {
    const at = Date.parse("2026-10-09T12:01:00Z");
    const pre = (symbol: string, close: number, change: number, print?: number): Quote => ({ symbol, currency: "USD", listingExchangeName: "NASDAQ",
      marketState: "PRE", previousClose: close, regularClose: close, regularCloseSessionDate: "2026-10-08", regularChange: change,
      regularChangePercent: (change / (close - change)) * 100, changeSessionDate: "2026-10-09", lastUpdated: at,
      price: print ?? close, change: print ? print - close : 0, changePercent: print ? ((print - close) / close) * 100 : 0,
      preMarketPrice: print, preMarketChange: print ? print - close : undefined, preMarketChangePercent: print ? ((print - close) / close) * 100 : undefined });
    const [spcx, nvda, aapl] = overlay([pre("SPCX", 160.57, -7.03, 166.95), pre("NVDA", 230.48, -6.99)]);
    expect(spcx).toMatchObject({ price: 166.95, extendedSession: "PRE", regularChangePercent: null });
    expect(spcx!.changePercent).toBeCloseTo(3.9733, 3);
    // Streamed without a print, the last session's close and move are what the snapshot says, not a flat live move.
    expect(nvda).toMatchObject({ price: 230.48 });
    expect(nvda!.changePercent).toBeCloseTo(-2.9435, 3);
    expect(nvda!.extendedSession).toBeUndefined();
    expect(aapl).toBe(rows[2]!);

    // A frame that lacks the close and move keeps the snapshot's pair rather than a flat live move.
    const bare: Quote = { ...pre("NVDA", 230.48, -6.99), regularClose: undefined, regularChange: undefined, regularChangePercent: undefined };
    expect(overlay([bare])[1]).toMatchObject({ price: 230.48, change: -6.99, changePercent: -2.9435, regularChangePercent: -2.9435 });
  });

  test("after hours a name with an after-hours print shows it from the close, marked; one that stopped at the close keeps its snapshot", () => {
    const at = Date.parse("2026-10-08T23:00:00Z");
    const post: Quote = { symbol: "SPCX", currency: "USD", listingExchangeName: "NASDAQ", marketState: "POST", price: 165.39, change: -2.21, changePercent: -1.3186,
      previousClose: 167.6, regularClose: 160.57, regularCloseSessionDate: "2026-10-08", changeSessionDate: "2026-10-08", lastUpdated: at,
      postMarketPrice: 165.39, postMarketChange: 4.82, postMarketChangePercent: 3.0018 };
    expect(overlay([post])[0]).toMatchObject({ price: 165.39, extendedSession: "POST" });
    // After 20:00 New York, without the close on the frame, the live price against the previous close is not a move for the tile.
    const overnight: Quote = { ...post, marketState: "POSTPOST", regularClose: undefined, regularCloseSessionDate: undefined,
      postMarketPrice: undefined, postMarketChange: undefined, postMarketChangePercent: undefined };
    expect(overlay([overnight])[0]).toMatchObject({ price: 160.57, change: -7.03, changePercent: -4.1945 });
    // While the session trades the live quote is the tile.
    const open: Quote = { ...overnight, marketState: "REGULAR", price: 161, change: 1, changePercent: 0.6 };
    expect(overlayScreenerQuoteEntries(rows, entriesFor([open]), { extendedSessions: true })[0]).toMatchObject({ price: 161, changePercent: 0.6, regularChangePercent: null });
  });
});
