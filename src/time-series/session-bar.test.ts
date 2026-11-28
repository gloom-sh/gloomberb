import { expect, test } from "bun:test";
import type { PricePoint, Quote } from "../types/financials";
import { intradayQuoteMembership } from "./chart-data";
import { finalDailyBars, withSessionBar } from "./session-bar";

const day = new Date("2026-11-27");
const friday = Date.parse("2026-11-27T21:59:00Z");
const saturday = Date.parse("2026-11-28T06:00:00Z");
const apple: Quote = {
  symbol: "AAPL", instrumentType: "Common Stock", listingExchangeName: "NASDAQ", currency: "USD",
  price: 359.25, lastUpdated: friday, change: 3.67, changePercent: 1.03, marketState: "CLOSED",
  regularClose: 358.54, regularCloseSessionDate: "2026-11-27", open: 358.21, high: 359.5, low: 355.64, volume: 22_825_593,
};
const options = { now: saturday, barSize: "1d" as const };

test("history and completed-close consumers keep only the verified cash close from either kind of suspect daily row", () => {
  const prior = { date: new Date("2026-11-25"), close: 355.58 };
  for (const { quote, row } of [
    { quote: apple, row: { date: day, open: 358.21, high: 359.5, low: 355.64, close: 359.25, volume: 22_825_593 } },
    { quote: { ...apple, symbol: "SPY", listingExchangeName: "ARCA", instrumentType: "ETF", price: 731.3, regularClose: 728.32 },
      row: { date: day, open: 725.86, high: 731.3, low: 719.61, close: 731.3, volume: 40_502_032 } },
  ]) {
    const expected = [prior, { date: day, close: quote.regularClose }];
    for (const latest of [row, { ...row, partial: true }, { date: day, close: quote.regularClose!, partial: true }]) {
      expect(withSessionBar([prior, latest], quote, options)).toEqual(expected);
      expect(finalDailyBars([prior, latest], options, quote)).toEqual(expected);
    }
  }
});

test("a close from another date or a stale regular label cannot finalize a US partial row", () => {
  const points: PricePoint[] = [{ date: day, close: 359.25, partial: true }];
  for (const quote of [
    { ...apple, regularCloseSessionDate: "2026-11-25" },
    { ...apple, marketState: "REGULAR" as const, regularClose: undefined },
    { ...apple, marketState: "CLOSED" as const, regularCloseSessionDate: undefined },
  ]) {
    expect(withSessionBar(points, quote, options)).toBe(points);
    expect(finalDailyBars(points, options, quote)).toEqual([]);
  }
  const consistent = [{ date: day, close: 358.540008544921875, open: 358.21, high: 358.7, low: 355.64, volume: 12_000_000 }];
  expect(withSessionBar(consistent, apple, options)).toBe(consistent);
});

test("real cash instrument spellings follow the early and ordinary bell without imposing US hours on other assets", () => {
  for (const bell of ["2026-11-27T18:00:00Z", "2026-11-25T21:00:00Z"]) {
    const lastUpdated = Date.parse(bell);
    for (const instrumentType of ["Common Stock", "Exchange Traded Fund", "ETF", "STK"]) {
      const cash = { ...apple, instrumentType, lastUpdated, marketState: "REGULAR" as const, regularClose: undefined };
      expect(intradayQuoteMembership(cash, "NASDAQ", false)).toEqual({ time: lastUpdated - 1 });
      expect(intradayQuoteMembership({ ...cash, lastUpdated: lastUpdated + 60_000 }, "NASDAQ", false)).toBeNull();
    }
    for (const instrumentType of ["Index", "Currency", "Future", "Cryptocurrency"]) {
      expect(intradayQuoteMembership({ ...apple, instrumentType, lastUpdated }, "NASDAQ", false)).toEqual({ time: lastUpdated });
    }
  }
  const hk = { ...apple, symbol: "0700", listingExchangeName: "HKEX", price: 430, regularClose: undefined,
    lastUpdated: Date.parse("2026-11-27T08:00:00Z") };
  expect(finalDailyBars([{ date: day, close: 427, partial: true }], options, hk).at(-1)?.close).toBe(430);
});
