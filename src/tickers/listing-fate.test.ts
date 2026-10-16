import { expect, test } from "bun:test";
import { createTestQuote } from "../test-support/data-provider";
import { MOVED_SYMBOL_CHANGES as CHANGES, MOVED_SYMBOL_QUOTES as QUOTES } from "../test-support/moved-symbols";
import type { TickerChanges } from "../types/ticker-changes";
import { describeListingFate, listingFateGate, listingFateNotes } from "./listing-fate";

test("what became of a symbol is one line from quote's sources: a listing that stopped, a company that left, bars from its old symbol", () => {
  const now = Date.parse("2026-10-12T06:00:00Z");
  const lastTrade = Date.parse("2022-10-27T23:59:59.953Z");
  const twitter = createTestQuote({ symbol: "TWTR", price: 53.86, lastUpdated: lastTrade, lastTradeTime: lastTrade, stale: true });
  const ended = describeListingFate({ symbol: "TWTR" }, twitter, null, now);
  expect(ended.endedOn).toBe("2022-10-27");
  // Said where nothing was served; data that was served speaks for itself.
  expect(listingFateNotes(ended, { served: false })).toEqual(["TWTR stopped trading 2022-10-27; no history or options served"]);
  expect(listingFateNotes(ended, { served: true })).toEqual([]);

  const hop = { from: "FB", to: "META", date: "2022-06-09" };
  const fb: TickerChanges = { symbol: "FB", moved: { symbol: "META", name: "Meta Platforms, Inc.", hops: [hop] }, formerly: null, listedName: null, changes: [hop] };
  const etf = createTestQuote({ symbol: "FB", name: "ProShares S&P 500 Dynamic Daily Buffer ETF", listingExchangeName: "BATS", lastUpdated: now });
  // The fund's bars or none, the line is quote's.
  const moved = describeListingFate({ symbol: "FB" }, etf, fb, now);
  const line = "FB now lists ProShares S&P 500 Dynamic Daily Buffer ETF; Meta Platforms trades as META (changed 2022-06-09)";
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
