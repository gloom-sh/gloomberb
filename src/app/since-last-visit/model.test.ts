import { describe, expect, test } from "bun:test";
import { quoteServedFromSavedCopy } from "../../data/saved-copies";
import { createTestQuote } from "../../test-support/data-provider";
import { createTestTicker } from "../../test-support/ticker";
import { createDefaultConfig } from "../../types/config";
import type { Quote } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import {
  formatVisitTime,
  liveMovePercent,
  MIN_AWAY_MS,
  moveSince,
  observeQuote,
  readVisitBaseline,
  recapSince,
  trackedListings,
  type TrackedListing,
  type VisitBaseline,
  type VisitObservation,
} from "./model";

/** Monday 14:00 New York: NASDAQ in its regular session. */
const NOW = Date.parse("2026-09-14T18:00:00Z");
const HOUR = 60 * 60_000;

function quote(price: number, overrides: Partial<Quote> = {}): Quote {
  return createTestQuote({
    symbol: "NVDA", price, lastUpdated: NOW - 60_000,
    exchangeName: "NASDAQ", listingExchangeName: "NASDAQ", marketState: "REGULAR",
    ...overrides,
  });
}

function observation(price: number, overrides: Partial<VisitObservation> = {}): VisitObservation {
  return { symbol: "NVDA", price, currency: "USD", basis: "per-unit", venue: "NASDAQ", at: NOW - 3 * HOUR, ...overrides };
}

function listing(symbol: string, exchange = "NASDAQ"): TrackedListing {
  return { key: `${symbol}|${exchange}|||`, symbol, instrument: { symbol, exchange } };
}

function baseline(observations: Record<string, VisitObservation>, seenAt = NOW - 3 * HOUR): VisitBaseline {
  return { scope: "local", seenAt, observations };
}

describe("observeQuote", () => {
  test("keeps a current print with its currency, basis and venue", () => {
    expect(observeQuote("NVDA", quote(120), NOW)).toEqual({
      symbol: "NVDA", price: 120, currency: "USD", basis: "per-unit", venue: "NASDAQ", at: NOW - 60_000,
    });
    expect(observeQuote("TY", quote(110, { priceBasis: "thirty-seconds" }), NOW)?.basis).toBe("thirty-seconds");
  });

  test("is no price at all when it cannot be said to have been seen", () => {
    const rejected: Array<[string, Quote | null]> = [
      ["missing", null],
      ["zero", quote(0)],
      ["no currency", quote(120, { currency: "" })],
      ["marked stale", quote(120, { stale: true })],
      ["yesterday's print in today's session", quote(120, { lastUpdated: NOW - 24 * HOUR })],
      ["nominal", quote(120, { nominalPrice: { session: "2026-09-14", lastTraded: null } })],
      ["delisted", quote(120, { delisting: { date: "2026-09-01" } as Quote["delisting"] })],
      ["a saved copy after a failed refresh", quoteServedFromSavedCopy(quote(120), NOW - HOUR)],
    ];
    for (const [, value] of rejected) expect(observeQuote("NVDA", value, NOW)).toBeNull();
  });
});

describe("moveSince", () => {
  test("measures two prices of one listing, the newer printed after the older", () => {
    expect(moveSince(observation(100), observation(110, { at: NOW }))).toBeCloseTo(10, 10);
    expect(moveSince(observation(100), observation(110, { at: NOW - 3 * HOUR }))).toBeNull();
    expect(moveSince(observation(100, { at: NOW }), observation(110, { at: NOW - HOUR }))).toBeNull();
  });

  test("never compares across a currency, a price basis, a venue or another ticker", () => {
    const after = observation(110, { at: NOW });
    expect(moveSince(observation(100, { currency: "GBp" }), { ...after, currency: "GBP" })).toBeNull();
    expect(moveSince(observation(100, { basis: "percent-of-par" }), after)).toBeNull();
    expect(moveSince(observation(100, { venue: "TSX" }), after)).toBeNull();
    expect(moveSince(observation(100, { symbol: "SHOP" }), after)).toBeNull();
  });

  test("leaves out a move a split would make, and anything in a split's session", () => {
    expect(moveSince(observation(400), observation(100, { at: NOW }))).toBeNull();
    expect(moveSince(observation(10), observation(100, { at: NOW }))).toBeNull();
    expect(moveSince(observation(150), observation(100.2, { at: NOW }))).toBeNull();
    expect(moveSince(observation(100), observation(103, { at: NOW, split: true }))).toBeNull();
    expect(moveSince(observation(100), observation(70, { at: NOW }))).toBeCloseTo(-30, 10);
  });
});

describe("recapSince", () => {
  const nvda = listing("NVDA");
  const shopTsx = listing("SHOP", "TSX");
  const amd = listing("AMD");

  test("nothing without a last visit, or when it was under an hour ago", () => {
    const current = new Map([[nvda.key, observation(120, { at: NOW })]]);
    expect(recapSince(null, [nvda], current, NOW)).toBeNull();
    expect(recapSince(baseline({ [nvda.key]: observation(100) }, NOW - MIN_AWAY_MS + 1), [nvda], current, NOW)).toBeNull();
    expect(recapSince(baseline({ [nvda.key]: observation(100) }, NOW - MIN_AWAY_MS), [nvda], current, NOW)?.moves).toHaveLength(1);
  });

  test("a listing without a price on either side is left out, never shown as unchanged", () => {
    const amdBefore = observation(50, { symbol: "AMD" });
    const recap = recapSince(
      baseline({ [nvda.key]: observation(100), [amd.key]: amdBefore }),
      [nvda, amd],
      // AMD has no current price (stale, failed or still loading).
      new Map([[nvda.key, observation(95, { at: NOW })]]),
      NOW,
    );
    expect(recap?.moves.map((move) => move.symbol)).toEqual(["NVDA"]);
    expect(recap?.moves[0]?.percent).toBeCloseTo(-5, 10);
  });

  test("a symbol on another listing is another ticker: its old price is not this one's", () => {
    const shopNyse = listing("SHOP", "NYSE");
    const recap = recapSince(
      baseline({ [shopNyse.key]: observation(80, { symbol: "SHOP", venue: "NYSE" }) }),
      [shopTsx],
      new Map([[shopTsx.key, observation(110, { symbol: "SHOP", venue: "TSX", currency: "CAD", at: NOW })]]),
      NOW,
    );
    expect(recap).toBeNull();
  });

  test("names the biggest moves either way above the floor, and only tickers still tracked", () => {
    const tickers = ["A", "B", "C", "D", "E", "F", "G"].map((symbol) => listing(symbol));
    const before: Record<string, VisitObservation> = {};
    const current = new Map<string, VisitObservation>();
    const after = [100.5, 103, 96, 110, 99.2, 101.5, 120];
    tickers.forEach((entry, index) => {
      before[entry.key] = observation(100, { symbol: entry.symbol });
      current.set(entry.key, observation(after[index]!, { symbol: entry.symbol, at: NOW }));
    });
    const recap = recapSince(baseline(before), tickers.slice(0, 6), current, NOW);
    // G left the collections; A and E moved under 1%.
    expect(recap?.moves.map((move) => move.symbol)).toEqual(["D", "C", "B", "F"]);
    expect(recapSince(baseline(before), tickers, current, NOW, { limit: 2 })?.moves.map((move) => move.symbol)).toEqual(["G", "D"]);
  });
});

describe("liveMovePercent", () => {
  const move = { key: "NVDA|NASDAQ|||", symbol: "NVDA", percent: 10, before: observation(100) };

  test("follows the quote on hand, keeps its number while none is current, and gives up when they stop comparing", () => {
    expect(liveMovePercent(move, quote(120), NOW)).toBeCloseTo(20, 10);
    expect(liveMovePercent(move, quote(120, { stale: true }), NOW)).toBe(10);
    expect(liveMovePercent(move, null, NOW)).toBe(10);
    expect(liveMovePercent(move, quote(120, { currency: "EUR" }), NOW)).toBeNull();
  });
});

describe("trackedListings", () => {
  test("the user's own holdings first, then watchlists, without team, imported or option rows", () => {
    const config = {
      ...createDefaultConfig("/tmp/since-last-visit"),
      portfolios: [
        { id: "main", name: "Main", currency: "USD" },
        { id: "team", name: "Team", currency: "USD", teamId: "t1" },
        { id: "13f", name: "Fund", currency: "USD", importedFrom: { kind: "13f" as const, cik: "1", name: "F", period: "2026-06-30", filed: "2026-08-14" } },
      ],
      watchlists: [{ id: "watch", name: "Watch" }, { id: "shared", name: "Shared", teamId: "t1" }],
    };
    const tickers = new Map<string, TickerRecord>([
      ["AAPL", createTestTicker("AAPL", "Apple", { watchlists: ["watch"] })],
      ["NVDA", createTestTicker("NVDA", "NVIDIA", { portfolios: ["main"] })],
      ["TEAM", createTestTicker("TEAM", "Team only", { portfolios: ["team"], watchlists: ["shared"] })],
      ["BRK", createTestTicker("BRK", "Imported", { portfolios: ["13f"] })],
      ["SPY 261218C600", createTestTicker("SPY 261218C600", "Option", { portfolios: ["main"], assetCategory: "OPT" })],
      ["SHOP", createTestTicker("SHOP", "Shopify", { exchange: "TSX", currency: "CAD", watchlists: ["watch"] })],
      ["LOOSE", createTestTicker("LOOSE")],
    ]);
    const tracked = trackedListings(config, tickers);
    expect(tracked.map((entry) => entry.symbol)).toEqual(["NVDA", "AAPL", "SHOP"]);
    expect(tracked[2]?.key).toContain("TSX");
    expect(trackedListings(config, tickers, 2).map((entry) => entry.symbol)).toEqual(["NVDA", "AAPL"]);
  });
});

describe("readVisitBaseline", () => {
  test("reads only a whole baseline of the asking account, dropping damaged prices", () => {
    const stored = {
      scope: "account:a",
      seenAt: NOW,
      observations: { good: observation(100), bad: { ...observation(100), price: "100" }, worse: null },
    };
    expect(readVisitBaseline(stored, "account:b")).toBeNull();
    expect(readVisitBaseline({ ...stored, seenAt: "yesterday" }, "account:a")).toBeNull();
    expect(Object.keys(readVisitBaseline(stored, "account:a")?.observations ?? {})).toEqual(["good"]);
  });
});

describe("formatVisitTime", () => {
  test("dates the last visit by how long ago it was, on the local clock", () => {
    const now = new Date(2026, 10, 13, 15, 0).getTime();
    expect(formatVisitTime(new Date(2026, 10, 13, 9, 30).getTime(), now)).toBe("09:30");
    expect(formatVisitTime(new Date(2026, 10, 12, 16, 5).getTime(), now)).toBe("yesterday 16:05");
    expect(formatVisitTime(new Date(2026, 10, 11, 16, 5).getTime(), now)).toBe("Wed 16:05");
    expect(formatVisitTime(new Date(2026, 10, 4, 16, 5).getTime(), now)).toBe("4 Nov");
    expect(formatVisitTime(new Date(2025, 10, 4, 16, 5).getTime(), now)).toBe("4 Nov 2025");
  });
});
