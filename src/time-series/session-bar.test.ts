import { describe, expect, test } from "bun:test";
import type { PricePoint, Quote } from "../types/financials";
import { requestedBarSize } from "./bar-spacing";
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

  test("a thin listing's daily bars a week or two apart stay daily, and a day's bar is final once its session has closed", () => {
    // B95 on SGX: trades on 13 Oct, 22 Oct and 6 Nov, Friday's bar still flagged partial by the source on Sunday.
    const thin = daily(["2026-10-13", { close: 1 }], ["2026-10-22", { close: 1.003 }],
      ["2026-11-06", { open: 1.029, high: 1.029, low: 1.012, close: 1.012, volume: 3661, partial: true }]);
    const sgx = quote({ symbol: "B95", price: 1.012, previousClose: 1.009, open: 1.029, high: 1.029, low: 1.012, volume: 3661,
      currency: "SGD", lastUpdated: Date.parse("2026-11-06T01:01:00Z"), marketState: "CLOSED", changeSessionDate: "2026-11-06",
      listingExchangeName: "SGX", instrumentType: "ETF" });
    const sunday = Date.parse("2026-11-08T01:00:00Z");
    const settled = withSessionBar(thin, sgx, { now: sunday, barSize: "1d" });
    expect(settled.slice(0, 2)).toEqual(thin.slice(0, 2));
    expect(settled[2]).toMatchObject({ close: 1.012, volume: 3661 });
    expect(settled[2]!.partial).toBeUndefined();
    // Within half an hour of the bell a delayed quote may still be catching up: the bar stays partial.
    const justClosed = Date.parse("2026-11-06T09:30:00Z");
    expect(withSessionBar(thin, sgx, { now: justClosed, barSize: "1d" }).at(-1)!.partial).toBe(true);
    // On B3 a closed quote can end on a print after the closing call: its official close is the source's bar, waited for.
    const b3 = { ...sgx, symbol: "PETR4", listingExchangeName: "B3", exchangeName: "B3", currency: "BRL", instrumentType: "Common Stock" };
    expect(withSessionBar(thin, b3, { now: Date.parse("2026-11-08T12:00:00Z"), barSize: "1d" }).at(-1)!.partial).toBe(true);
    // A quote from another session settles nothing.
    expect(withSessionBar(thin, { ...sgx, changeSessionDate: "2026-11-05", lastUpdated: Date.parse("2026-11-05T08:00:00Z") },
      { now: sunday, barSize: "1d" }).at(-1)!.partial).toBe(true);
  });

  test("a BIST share's day is final after Istanbul's close, read that night with New York still open", () => {
    // GUBRF on Tue 10 Nov 2026: the source still flagged the day partial at 20:29Z, hours after the 18:10 close.
    const bars = daily(["2026-11-09", { close: 307 }],
      ["2026-11-10", { open: 308, high: 308, low: 287.5, close: 288, volume: 4_442_906, partial: true }]);
    const gubrf = quote({ symbol: "GUBRF", price: 288, previousClose: 307, open: 308, high: 308, low: 287.5, volume: 4_442_906,
      currency: "TRY", lastUpdated: Date.parse("2026-11-10T15:10:00Z"), marketState: "CLOSED", changeSessionDate: "2026-11-10",
      listingExchangeName: "BIST" });
    expect(withSessionBar(bars, gubrf, { now: Date.parse("2026-11-10T20:29:00Z"), barSize: "1d" }).at(-1)!.partial).toBeUndefined();
    // The closing auction and trading at the close run to 18:10 (15:10Z), and a delayed copy lags half an hour after.
    const at = (time: string) => withSessionBar(bars, gubrf, { now: Date.parse(time), barSize: "1d" }).at(-1)!.partial;
    expect(at("2026-11-10T15:35:00Z")).toBe(true);
    expect(at("2026-11-10T15:41:00Z")).toBeUndefined();
  });

  test("the size asked for, not the spacing, says what the bars are; spacing only shows bars coarser when each starts its period", () => {
    const days = (...dates: string[]) => dates.map((date) => Date.parse(`${date}T00:00:00Z`));
    expect(requestedBarSize(days("2026-10-13", "2026-10-22", "2026-11-06"), "1d")).toBe("1d");
    // Four Mondays a week apart are weekly bars, the first of four months monthly ones, whatever was asked.
    expect(requestedBarSize(days("2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"), "1d")).toBe("1wk");
    expect(requestedBarSize(days("2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"), "1d")).toBe("1mo");
    // Three are too few to say so: a thin listing can trade on three Mondays.
    expect(requestedBarSize(days("2026-10-05", "2026-10-12", "2026-10-19"), "1d")).toBe("1d");
    // The size the source says it served stands.
    expect(requestedBarSize(days("2026-10-05", "2026-10-12", "2026-10-19"), "1d", "1wk")).toBe("1wk");
    // Bars finer than asked are as served.
    expect(requestedBarSize(days("2026-10-13", "2026-10-14", "2026-10-15"), "1wk")).toBe("1d");
  });
});
