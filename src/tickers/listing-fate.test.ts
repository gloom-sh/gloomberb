import { expect, test } from "bun:test";
import { createTestQuote } from "../test-support/data-provider";
import { MOVED_SYMBOL_CHANGES as CHANGES, MOVED_SYMBOL_QUOTES as QUOTES } from "../test-support/moved-symbols";
import type { TickerChanges } from "../types/ticker-changes";
import { describeListingFate, listingFateGate, listingFateNotes, loadNoQuoteLastTraded, noLongerListedNote, noQuoteLastTraded } from "./listing-fate";

test("what became of a symbol is one line from quote's sources: a listing that stopped, a company that left, bars from its old symbol", () => {
  const now = Date.parse("2026-10-12T06:00:00Z");
  const lastTrade = Date.parse("2022-10-27T23:59:59.953Z");
  const twitter = createTestQuote({ symbol: "TWTR", price: 53.86, lastUpdated: lastTrade, lastTradeTime: lastTrade, stale: true });
  const ended = describeListingFate({ symbol: "TWTR" }, twitter, null, now);
  expect(ended.endedOn).toBe("2022-10-27");
  // Said where nothing was served; data that was served speaks for itself.
  expect(listingFateNotes(ended, { served: false })).toEqual(["TWTR stopped trading 2022-10-27; no history or options served"]);
  expect(listingFateNotes(ended, { served: true })).toEqual([]);
  // Once the service says it no longer trades, its history is served, ending on that session, and says so.
  const delisted = describeListingFate({ symbol: "TWTR" }, { ...twitter,
    delisting: { status: "delisted", lastTradeDate: "2022-10-27", historyStart: "2016-01-04" } }, null, now);
  expect(delisted.endedOn).toBe("2022-10-27");
  expect(listingFateNotes(delisted, { served: true })).toEqual(["TWTR: Delisted Oct 27, 2022"]);
  expect(listingFateNotes(delisted, { served: false })).toEqual(["TWTR: Delisted Oct 27, 2022"]);

  const hop = { from: "FB", to: "META", date: "2022-06-09" };
  const fb: TickerChanges = { symbol: "FB", moved: { symbol: "META", name: "Meta Platforms, Inc.", hops: [hop] }, formerly: null, listedName: null, changes: [hop] };
  const etf = createTestQuote({ symbol: "FB", name: "ProShares S&P 500 Dynamic Daily Buffer ETF", listingExchangeName: "BATS", lastUpdated: now });
  // The fund's bars or none, the line is quote's.
  const moved = describeListingFate({ symbol: "FB" }, etf, fb, now);
  const line = "FB now lists ProShares S&P 500 Dynamic Daily Buffer ETF; FB was Meta Platforms before, now META (changed 2022-06-09)";
  expect(listingFateNotes(moved, { served: true, firstDate: "2025-10-13" })).toEqual([line]);
  expect(listingFateNotes(moved, { served: false })).toEqual([line]);
  // Read on a listing abroad, the symbol is not the US one the changes are of.
  expect(describeListingFate({ symbol: "FB" }, { ...etf, listingExchangeName: "PSE" }, fb, now).note).toBeNull();

  const meta: TickerChanges = { symbol: "META", moved: null, formerly: [hop], listedName: "Meta Platforms, Inc.", changes: [hop] };
  const holder = describeListingFate({ symbol: "META" }, createTestQuote({ symbol: "META", lastUpdated: now }), meta, now);
  expect(holder.note).toBeNull();
  expect(listingFateNotes(holder, { served: true, firstDate: "2021-10-18" })).toEqual(["Includes FB-era bars: META was FB until 2022-06-09"]);
  expect(listingFateNotes(holder, { served: true, firstDate: "2022-06-13" })).toEqual([]);
});

test("a pane serves a symbol at once unless its quote shows the line ended, and shows only where a moved company went", () => {
  const now = Date.parse("2026-10-15T15:00:00Z");
  const aapl = { ...QUOTES.AAPL!, lastUpdated: now, lastTradeTime: now };
  const meta = { ...QUOTES.META!, lastUpdated: now, lastTradeTime: now };
  const gate = (symbol: string, quote: typeof aapl | null | undefined, changes: TickerChanges | null | undefined) => {
    const found = listingFateGate({ symbol }, { quote, changes }, now);
    return found.kind === "moved" ? found.change.note : found.kind;
  };
  // Nothing waits on a lookup, however slow, but a line whose quote shows it ended: not a quote that trades,
  // one cached from an earlier session, one still coming (a cold open), or no quote at all.
  expect(gate("AAPL", aapl, undefined)).toBe("serve");
  const lastWeek = now - 7 * 24 * 60 * 60_000;
  expect(gate("AAPL", { ...aapl, lastUpdated: lastWeek, lastTradeTime: lastWeek }, undefined)).toBe("serve");
  expect(gate("AAPL", undefined, undefined)).toBe("serve");
  expect(gate("AAPL", null, undefined)).toBe("serve");
  expect(gate("HFC", QUOTES.HFC, undefined)).toBe("wait");
  // A company that left with nothing known listed there waits for the quote; with a new listing named, it serves.
  expect(gate("HFC", undefined, CHANGES.HFC)).toBe("wait");
  expect(gate("HFC", undefined, { ...CHANGES.HFC!, listedName: "Hightower Fund" })).toBe("serve");
  expect(gate("HFC", QUOTES.HFC, CHANGES.HFC)).toBe("HFC became DINO on 2022-03-15");
  expect(gate("RDS-A", QUOTES["RDS-A"], CHANGES["RDS-A"])).toBe("RDS-A became SHEL on 2022-01-31");
  // A lookup that failed or timed out is no change; a new company holding the symbol is not a move.
  expect(gate("HFC", QUOTES.HFC, null)).toBe("serve");
  expect(gate("META", meta, CHANGES.META)).toBe("serve");
  expect(gate("META", undefined, CHANGES.META)).toBe("serve");
  // A moved company whose old symbol now lists something else that trades serves that.
  expect(gate("HFC", createTestQuote({ symbol: "HFC", name: "Hightower Fund", lastUpdated: now, lastTradeTime: now }), CHANGES.HFC)).toBe("serve");
});

test("a listing with no quote stopped trading when its history says so or its newest bar is over a month old; its own US line is read", async () => {
  const now = Date.parse("2026-11-01T21:00:00Z");
  const bar = (date: string) => ({ date: new Date(`${date}T00:00:00Z`), open: 1, high: 1, low: 1, close: 1 });
  // The history's own last day wins over its bars.
  expect(noQuoteLastTraded({ points: [bar("2020-06-02")], delisting: { status: "inactive", lastTradeDate: "2020-06-03", historyStart: "2016-01-04" } }, now)).toBe("2020-06-03");
  expect(noQuoteLastTraded({ points: [bar("2026-09-28")] }, now)).toBe("2026-09-28");
  // A quiet month, or nothing at all, is no ending.
  expect(noQuoteLastTraded({ points: [bar("2026-10-05")] }, now)).toBeNull();
  expect(noQuoteLastTraded({ points: [] }, now)).toBeNull();
  expect(noLongerListedNote("FLAT", "2020-06-03")).toBe("FLAT last traded 2020-06-03; no longer listed");

  // STPP: the bare symbol's bars are a fund abroad's; its US line on any US venue ended in 2020.
  const asked: string[] = [];
  const provider = {
    getQuoteMetadata: async () => null,
    getPriceHistory: async () => [],
    getPriceHistoryWithMetadata: async (symbol: string, exchange: string) => {
      asked.push(`${symbol}:${exchange}`);
      return exchange ? { points: [bar("2020-07-16")], resolution: null, delisting: { status: "inactive" as const, lastTradeDate: "2020-07-16", historyStart: "2016-01-04" } }
        : { points: [bar("2026-09-28")], resolution: null };
    },
  };
  expect(await loadNoQuoteLastTraded({ symbol: "STPP", exchange: "" }, provider, now)).toBe("2020-07-16");
  expect(asked).toEqual(["STPP:NYSE"]);
  // A failed read says nothing.
  expect(await loadNoQuoteLastTraded({ symbol: "STPP" }, { ...provider, getPriceHistoryWithMetadata: async () => { throw new Error("down"); } }, now)).toBeNull();
});
