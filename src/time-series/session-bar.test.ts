import { describe, expect, test } from "bun:test";
import type { PricePoint, Quote } from "../types/financials";
import { withSessionBar } from "./session-bar";

// Fri 16 Oct 2026, 15:14 in New York: the session is open.
const NOW = Date.parse("2026-10-16T19:14:30Z");

function daily(...closes: Array<[string, Partial<PricePoint>]>): PricePoint[] {
  return closes.map(([date, values]) => ({ date: new Date(`${date}T00:00:00Z`), open: 100, high: 105, low: 95, close: 100, volume: 30_000_000, ...values }));
}

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "AAPL", price: 340.91, currency: "USD", change: -1.09, changePercent: -0.32, previousClose: 342,
    open: 346.085, high: 347.8, low: 340.46, volume: 39_269_651,
    lastUpdated: NOW - 15 * 60_000, marketState: "REGULAR", changeSessionDate: "2026-10-16",
    listingExchangeName: "NASDAQ", instrumentType: "Common Stock", ...overrides,
  };
}

/** What Gloom Cloud served at 19:13Z: the newest bar a snapshot of the first minutes of the session. */
const SNAPSHOT = daily(
  ["2026-10-13", { close: 341.27 }],
  ["2026-10-14", { close: 342.96 }],
  ["2026-10-15", { close: 342, volume: 39_678_300 }],
  ["2026-10-16", { open: 346.085, high: 347.8, low: 341.12, close: 341.995, volume: 1_096_219 }],
);

describe("withSessionBar", () => {
  test("rebuilds a snapshot of the opening minutes from the quote, marked partial, and never lowers what the bar already saw", () => {
    const merged = withSessionBar(SNAPSHOT, quote(), { now: NOW });
    expect(merged).toHaveLength(4);
    expect(merged.slice(0, 3)).toEqual(SNAPSHOT.slice(0, 3));
    expect(merged[3]).toMatchObject({ open: 346.085, high: 347.8, low: 340.46, close: 340.91, volume: 39_269_651, partial: true });
    expect(merged[3]!.date).toEqual(new Date("2026-10-16T00:00:00Z"));
    // The quote's range lags a later print of the bar: the bar's extremes stay.
    const lagging = withSessionBar(SNAPSHOT, quote({ high: 346, low: 341.5 }), { now: NOW }).at(-1)!;
    expect(lagging).toMatchObject({ high: 347.8, low: 340.91 });
    // And the volume, when a delayed quote counts fewer shares than the bar.
    expect(withSessionBar(SNAPSHOT, quote({ volume: 900_000 }), { now: NOW }).at(-1)!.volume).toBe(1_096_219);
    // The served history is not touched.
    expect(SNAPSHOT.at(-1)).toMatchObject({ close: 341.995, volume: 1_096_219 });
    expect(SNAPSHOT.at(-1)!.partial).toBeUndefined();
  });

  test("adds the day when the range was cut before the session opened, and finished days are untouched", () => {
    const cut = SNAPSHOT.slice(0, 3);
    const merged = withSessionBar(cut, quote(), { now: NOW });
    expect(merged).toHaveLength(4);
    expect(merged.slice(0, 3)).toEqual(cut);
    expect(merged[3]).toMatchObject({ open: 346.085, high: 347.8, low: 340.46, close: 340.91, volume: 39_269_651, partial: true });
    expect(merged[3]!.date).toEqual(new Date("2026-10-16T00:00:00Z"));
  });

  test("leaves the history as served when the session is closed, the listing is not a share, or its dates are not days", () => {
    const afterClose = Date.parse("2026-10-16T21:00:00Z");
    expect(withSessionBar(SNAPSHOT, quote({ marketState: "POST", lastUpdated: afterClose }), { now: afterClose })).toBe(SNAPSHOT);
    expect(withSessionBar(SNAPSHOT, quote({ instrumentType: "Cryptocurrency", symbol: "BTC-USD" }), { now: NOW })).toBe(SNAPSHOT);
    expect(withSessionBar(SNAPSHOT, quote({ symbol: "ES=F", instrumentType: undefined }), { now: NOW })).toBe(SNAPSHOT);
    expect(withSessionBar(SNAPSHOT, quote({ listingExchangeName: "CCC" }), { now: NOW })).toBe(SNAPSHOT);
    const hourly = [0, 1, 2, 3].map((hour): PricePoint => ({ date: new Date(Date.UTC(2026, 9, 16, 14 + hour)), close: 340 + hour }));
    expect(withSessionBar(hourly, quote(), { now: NOW })).toBe(hourly);
  });

  test("leaves out a bar for the day while the session trades and no current quote confirms it", () => {
    const stale = quote({ stale: true });
    expect(withSessionBar(SNAPSHOT, stale, { now: NOW }).map(({ date }) => date.toISOString().slice(0, 10)))
      .toEqual(["2026-10-13", "2026-10-14", "2026-10-15"]);
    expect(withSessionBar(SNAPSHOT, null, { now: NOW, venue: "NASDAQ" })).toHaveLength(3);
    // A venue the calendars do not know cannot say the day is running: the bar stays.
    expect(withSessionBar(SNAPSHOT, null, { now: NOW })).toBe(SNAPSHOT);
    // The weekend's history, or a session not yet open, loses nothing.
    const sunday = Date.parse("2026-10-18T15:00:00Z");
    expect(withSessionBar(SNAPSHOT, null, { now: sunday, venue: "NASDAQ" })).toBe(SNAPSHOT);
    expect(withSessionBar(SNAPSHOT, null, { now: Date.parse("2026-10-16T12:00:00Z"), venue: "NASDAQ" })).toBe(SNAPSHOT);
  });

  test("a weekly or monthly bar covering today takes the quote's price and extremes, its volume as served", () => {
    const weekly = daily(
      ["2026-09-28", { close: 330 }], ["2026-10-05", { close: 336.64, volume: 172_211_400 }],
      ["2026-10-12", { open: 338.22, high: 348.15, low: 337.6, close: 341.3, volume: 155_704_580 }],
    );
    expect(withSessionBar(weekly, quote(), { now: NOW }).at(-1)).toEqual({
      date: new Date("2026-10-12T00:00:00Z"), open: 338.22, high: 348.15, low: 337.6, close: 340.91, volume: 155_704_580,
    });
    const monthly = daily(["2026-08-01", {}], ["2026-09-01", {}], ["2026-10-01", { open: 330, high: 348.15, low: 325.81, close: 342, volume: 395_112_692 }]);
    expect(withSessionBar(monthly, quote({ low: 320 }), { now: NOW }).at(-1)).toMatchObject({ low: 320, close: 340.91, volume: 395_112_692 });
  });
});
