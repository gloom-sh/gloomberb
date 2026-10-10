import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { isProviderQuoteUsableForCurrentSession } from "./financials";
import { createTestQuote } from "../../test-support/data-provider";
import type { MarketState } from "../../types/financials";

// Delayed quotes through Asia-Pacific holidays, midday breaks and weekends.
// Times are the venue's own clock; each last print is what the delayed feed
// shows at that time.

/** [what, now, last print, reported state, usable]; times are local to the venue. */
type Row = [string, string, string, MarketState, boolean];

const local = (time: string, offset: string) => Date.parse(`${time.length === 16 ? `${time}:00` : time}${offset}`);

const VENUES: Record<string, { offset: string; symbol: string; rows: Row[] }> = {
  KRX: {
    offset: "+09:00",
    symbol: "005930",
    rows: [
      // Hangul Day, at 12:49 UTC, as served live.
      ["holiday, the day before's close", "2026-10-09T21:49", "2026-10-08T15:32", "CLOSED", true],
      ["holiday, an older close", "2026-10-09T21:49", "2026-10-07T15:32", "CLOSED", false],
      ["midday has no break", "2026-10-08T12:30", "2026-10-08T11:30", "REGULAR", false],
      ["10 min after the open", "2026-10-08T09:10", "2026-10-07T15:32", "CLOSED", true],
      ["mid-session", "2026-10-08T11:00", "2026-10-08T10:39", "REGULAR", true],
      ["mid-session, feed stopped", "2026-10-08T11:00", "2026-10-08T10:25", "REGULAR", false],
      ["weekend after the holiday", "2026-10-10T12:00", "2026-10-08T15:32", "CLOSED", true],
      ["Monday pre-open after the holiday", "2026-10-12T08:55", "2026-10-08T15:32", "CLOSED", true],
    ],
  },
  TWSE: {
    offset: "+08:00",
    symbol: "2330",
    rows: [
      // National Day observed, at 12:49 UTC, as served live.
      ["holiday, the day before's close", "2026-10-09T20:49", "2026-10-08T13:30:13", "CLOSED", true],
      ["holiday, an older close", "2026-10-09T20:49", "2026-10-07T13:30", "CLOSED", false],
      ["midday has no break", "2026-10-08T12:30", "2026-10-08T11:30", "REGULAR", false],
      ["10 min after the open", "2026-10-08T09:10", "2026-10-07T13:30", "CLOSED", true],
      ["mid-session", "2026-10-08T11:00", "2026-10-08T10:39", "REGULAR", true],
      ["mid-session, feed stopped", "2026-10-08T11:00", "2026-10-08T10:25", "REGULAR", false],
      ["weekend after the holiday", "2026-10-10T12:00", "2026-10-08T13:30:13", "CLOSED", true],
    ],
  },
  HKEX: {
    offset: "+08:00",
    symbol: "0700",
    rows: [
      ["holiday, the day before's close", "2026-10-01T20:00", "2026-09-30T16:08", "CLOSED", true],
      ["holiday, an older close", "2026-10-01T20:00", "2026-09-29T16:08", "CLOSED", false],
      ["lunch break", "2026-10-08T12:45", "2026-10-08T11:59", "REGULAR", true],
      ["lunch break, feed stopped mid-morning", "2026-10-08T12:45", "2026-10-08T11:20", "REGULAR", false],
      ["10 min after reopening", "2026-10-08T13:10", "2026-10-08T11:59", "REGULAR", true],
      ["afternoon prints due", "2026-10-08T13:21", "2026-10-08T11:59", "REGULAR", false],
      ["mid-session, feed stopped", "2026-10-08T11:00", "2026-10-08T10:25", "REGULAR", false],
      ["weekend", "2026-10-10T12:00", "2026-10-09T16:08", "CLOSED", true],
    ],
  },
  SGX: {
    offset: "+08:00",
    symbol: "D05",
    rows: [
      ["holiday, the day before's close", "2026-05-27T20:00", "2026-05-26T17:13", "CLOSED", true],
      ["holiday, an older close", "2026-05-27T20:00", "2026-05-25T17:13", "CLOSED", false],
      ["lunch break", "2026-10-08T12:45", "2026-10-08T11:59", "REGULAR", true],
      ["lunch break, feed stopped mid-morning", "2026-10-08T12:45", "2026-10-08T11:00", "REGULAR", false],
      // The feed runs twenty minutes behind.
      ["10 min after reopening", "2026-10-08T13:10", "2026-10-08T11:59", "REGULAR", true],
      ["afternoon prints due", "2026-10-08T13:26", "2026-10-08T11:59", "REGULAR", false],
      ["mid-session, feed stopped", "2026-10-08T11:00", "2026-10-08T10:25", "REGULAR", false],
      ["weekend", "2026-10-10T12:00", "2026-10-09T17:13:56", "CLOSED", true],
    ],
  },
  ASX: {
    offset: "+11:00",
    symbol: "BHP",
    rows: [
      ["Australia Day, the day before's close", "2027-01-26T20:00", "2027-01-25T16:20", "CLOSED", true],
      ["holiday, an older close", "2027-01-26T20:00", "2027-01-22T16:20", "CLOSED", false],
      ["midday has no break", "2026-10-08T13:00", "2026-10-08T12:00", "REGULAR", false],
      ["10 min after the open", "2026-10-08T10:10", "2026-10-07T16:20:39", "CLOSED", true],
      ["mid-session", "2026-10-08T13:00", "2026-10-08T12:39:48", "REGULAR", true],
      ["mid-session, feed stopped", "2026-10-08T13:00", "2026-10-08T12:25", "REGULAR", false],
      ["weekend", "2026-10-10T12:00", "2026-10-09T16:20:39", "CLOSED", true],
    ],
  },
  SSE: {
    offset: "+08:00",
    symbol: "600519",
    rows: [
      ["Dragon Boat holiday, the day before's close", "2026-06-19T20:00", "2026-06-18T15:00", "CLOSED", true],
      ["holiday, an older close", "2026-06-19T20:00", "2026-06-17T15:00", "CLOSED", false],
      ["lunch break", "2026-10-08T12:30", "2026-10-08T11:29", "REGULAR", true],
      ["lunch break, feed stopped mid-morning", "2026-10-08T12:30", "2026-10-08T10:45", "REGULAR", false],
      ["10 min after reopening", "2026-10-08T13:10", "2026-10-08T11:29", "REGULAR", true],
      ["afternoon prints due", "2026-10-08T13:21", "2026-10-08T11:29", "REGULAR", false],
      ["mid-session, feed stopped", "2026-10-08T10:30", "2026-10-08T09:55", "REGULAR", false],
      ["weekend", "2026-10-11T12:00", "2026-10-09T15:00", "CLOSED", true],
    ],
  },
  JPX: {
    offset: "+09:00",
    symbol: "7203",
    rows: [
      ["Culture Day, the day before's close", "2026-11-03T20:00", "2026-11-02T15:30", "CLOSED", true],
      ["holiday, an older close", "2026-11-03T20:00", "2026-10-30T15:30", "CLOSED", false],
      ["lunch break", "2026-10-08T12:15", "2026-10-08T11:30", "REGULAR", true],
      ["lunch break, feed stopped mid-morning", "2026-10-08T12:15", "2026-10-08T10:30", "REGULAR", false],
      ["10 min after reopening", "2026-10-08T12:40", "2026-10-08T11:30", "REGULAR", true],
      ["afternoon prints due", "2026-10-08T12:51", "2026-10-08T11:30", "REGULAR", false],
      ["mid-session, feed stopped", "2026-10-08T10:30", "2026-10-08T09:55", "REGULAR", false],
      ["weekend and Sports Day", "2026-10-12T12:00", "2026-10-09T15:30", "CLOSED", true],
    ],
  },
};

describe("Asia-Pacific delayed quotes through holidays, midday breaks and weekends", () => {
  let clock: ReturnType<typeof spyOn>;
  beforeEach(() => {
    clock = spyOn(Date, "now");
  });
  afterEach(() => clock.mockRestore());

  for (const [venue, { offset, symbol, rows }] of Object.entries(VENUES)) {
    test(venue, () => {
      for (const [what, now, lastPrint, marketState, usable] of rows) {
        clock.mockReturnValue(local(now, offset));
        const quote = createTestQuote({ symbol, listingExchangeName: venue, exchangeName: venue, marketState,
          dataSource: "delayed", lastUpdated: local(lastPrint, offset) });
        expect(isProviderQuoteUsableForCurrentSession(quote, venue), `${venue} ${what} (${now})`).toBe(usable);
      }
    });
  }

  test("keeps the Korean and Taiwanese closes served on 9 Oct 2026", () => {
    clock.mockReturnValue(Date.parse("2026-10-09T12:49:00Z"));
    for (const [symbol, venue, lastUpdated] of [
      ["005930", "KRX", Date.parse("2026-10-08T06:32:00Z")],
      ["2330", "TWSE", Date.parse("2026-10-08T05:30:13Z")],
    ] as const) {
      const quote = createTestQuote({ symbol, listingExchangeName: venue, exchangeName: venue, marketState: "CLOSED",
        dataSource: "delayed", stale: false, lastUpdated });
      expect(isProviderQuoteUsableForCurrentSession(quote, venue), venue).toBe(true);
    }
  });

  test("Kuala Lumpur and Jakarta pause at midday, Jakarta longer on Fridays", () => {
    const quote = (venue: string, lastUpdated: number) => createTestQuote({ listingExchangeName: venue,
      exchangeName: venue, marketState: "REGULAR", dataSource: "delayed", lastUpdated });
    const usableAt = (venue: string, offset: string, now: string, lastPrint: string) => {
      clock.mockReturnValue(local(now, offset));
      return isProviderQuoteUsableForCurrentSession(quote(venue, local(lastPrint, offset)), venue);
    };
    expect(usableAt("BURSAMY", "+08:00", "2026-10-09T13:05", "2026-10-09T12:30")).toBe(true);
    expect(usableAt("BURSAMY", "+08:00", "2026-10-09T13:05", "2026-10-09T12:00")).toBe(false);
    expect(usableAt("JAKARTA", "+07:00", "2026-10-09T13:50", "2026-10-09T11:29")).toBe(true);
    expect(usableAt("JAKARTA", "+07:00", "2026-10-09T14:21", "2026-10-09T11:29")).toBe(false);
    expect(usableAt("JAKARTA", "+07:00", "2026-10-08T12:40", "2026-10-08T11:59")).toBe(true);
    expect(usableAt("JAKARTA", "+07:00", "2026-10-08T14:00", "2026-10-08T11:59")).toBe(false);
    // Thursday trades through 11:30 to 12:00.
    expect(usableAt("JAKARTA", "+07:00", "2026-10-08T11:55", "2026-10-08T11:20")).toBe(false);
  });

  test("a real-time quote holds over lunch until afternoon prints are due", () => {
    const quote = createTestQuote({ listingExchangeName: "HKEX", exchangeName: "HKEX", marketState: "REGULAR",
      lastUpdated: local("2026-10-08T11:59:50", "+08:00") });
    clock.mockReturnValue(local("2026-10-08T12:40", "+08:00"));
    expect(isProviderQuoteUsableForCurrentSession(quote, "HKEX")).toBe(true);
    clock.mockReturnValue(local("2026-10-08T13:06", "+08:00"));
    expect(isProviderQuoteUsableForCurrentSession(quote, "HKEX")).toBe(false);
  });
});
