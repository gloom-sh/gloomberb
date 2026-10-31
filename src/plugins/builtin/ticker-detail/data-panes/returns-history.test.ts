import { expect, test } from "bun:test";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import type { PricePoint, Quote } from "../../../../types/financials";
import { loadReturnSeries } from "./returns-history";
import { buildReturnRows } from "./returns-model";

// VTI's hourly bars from Fri 2 Oct to Fri 9 Oct 2026, as Gloom Cloud serves them (bar open, regular session).
const HOURS = [13, 14, 15, 16, 17, 18, 19];
const VTI_1H: PricePoint[] = ["2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]
  .flatMap((date, day) => HOURS.map((hour, index) => ({ date: new Date(`${date}T${hour}:30:00Z`), close: 378 + day + index / 10 })));

test("a bare ticker on a weekend ends at its listing's last session, named by its quote", async () => {
  const asked: Array<{ start: string; end: string }> = [];
  const provider = createTestDataProvider({
    getQuoteMetadata: async (symbol) => ({ symbol, listingExchangeName: "ARCA", source: {} }),
    getDetailedPriceHistoryWithMetadata: async (_symbol, _exchange, start, end) => {
      asked.push({ start: start.toISOString(), end: end.toISOString() });
      return { points: VTI_1H, resolution: "1h" };
    },
  });
  // Sunday, with no exchange on the ticker: without the quote's listing the window would end now.
  const now = Date.parse("2026-10-11T15:00:00Z");
  const series = await loadReturnSeries(provider, { symbol: "VTI", exchange: "", range: "5D", resolution: "1h", support: [], now });

  expect(series).toMatchObject({ lastSession: "2026-10-09", venue: "ARCA", resolution: "1h", visibleTo: now });
  expect(new Date(series.visibleFrom).toISOString()).toBe("2026-10-04T20:00:00.000Z");
  // The request reaches back over the weekend before the window for the base bar, and up to now.
  expect(asked[0]).toEqual({ start: "2026-09-30T20:00:00.000Z", end: "2026-10-11T15:00:00.000Z" });
  const rows = buildReturnRows(series.points, series.visibleFrom, series.visibleTo);
  expect(rows).toHaveLength(35);
  expect(new Date(rows[0]!.timestamp).toISOString()).toBe("2026-10-09T19:30:00.000Z");
});

test("a coin on a weekend stays anchored to now and asks for no quote", async () => {
  let quoted = false;
  const provider = createTestDataProvider({
    getQuoteMetadata: async () => { quoted = true; return null; },
    getDetailedPriceHistoryWithMetadata: async () => ({ points: [], resolution: "1h" }),
    getPriceHistoryForResolutionWithMetadata: async () => ({ points: [], resolution: "1h" }),
  });
  const now = Date.parse("2026-10-11T15:00:00Z");
  const series = await loadReturnSeries(provider, { symbol: "BTC-USD", exchange: "", range: "5D", resolution: "1h", support: [], now });
  expect(series.lastSession).toBeUndefined();
  expect(new Date(series.visibleFrom).toISOString()).toBe("2026-10-06T15:00:00.000Z");
  expect(quoted).toBe(false);
});

test("a dated window keeps the week its first date falls in, and a source with no hourly bars that far back answers in daily ones", async () => {
  const asked: string[] = [];
  const monday = (date: string, close: number) => ({ date: new Date(`${date}T00:00:00Z`), close });
  const provider = createTestDataProvider({
    getDetailedPriceHistoryWithMetadata: async (_symbol, _exchange, _start, _end, interval) => {
      asked.push(interval);
      if (interval === "1h") return { points: [], resolution: "1h" };
      return { points: [monday("2008-09-08", 40), monday("2008-09-15", 44), monday("2008-09-22", 48)], resolution: interval === "1wk" ? "1wk" : "1d" };
    },
  });
  const now = Date.parse("2026-10-22T15:00:00Z");
  const request = { symbol: "JPM", exchange: "NYSE", range: "5D" as const, support: [], now };
  // Wednesday 17 Sep 2008 is in the week of Monday the 15th, whose bar is the window's first; the 8th's is its base.
  const weekly = await loadReturnSeries(provider, { ...request, resolution: "1wk", window: { from: "2008-09-17", to: "2010-09-30" } });
  expect(buildReturnRows(weekly.points, weekly.visibleFrom, weekly.visibleTo).map((row) => [new Date(row.timestamp).toISOString().slice(0, 10), row.cumulativePercent]))
    .toEqual([["2008-09-22", 0.2], ["2008-09-15", 0.1]]);
  const hourly = await loadReturnSeries(provider, { ...request, resolution: "1h", window: { from: "2008-09-15", to: "2008-09-22" } });
  expect(hourly.resolution).toBe("1d");
  expect(asked).toEqual(["1wk", "1h", "1d"]);
});

test("each closed session ends on its close: earlier ones from the daily bars, the newest from the quote or, on a weekend, its daily bar", async () => {
  const days = ["2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
  // The daily closes differ from the last hourly bar's trade (…+0.6), as an auction print does.
  const daily: PricePoint[] = days.map((date, day) => ({ date: new Date(`${date}T00:00:00Z`), close: 378 + day + 0.65 }));
  const provider = (quote: Partial<Quote>) => createTestDataProvider({
    getQuoteMetadata: async (symbol) => ({ symbol, listingExchangeName: "ARCA", currency: "USD", source: {} }),
    getDetailedPriceHistoryWithMetadata: async (_symbol, _exchange, _start, _end, interval) => (
      interval === "1d" ? { points: daily, resolution: "1d" } : { points: VTI_1H, resolution: "1h" }),
    getQuote: async (symbol) => ({ symbol, price: 383.6, change: 0, changePercent: 0, currency: "USD", listingExchangeName: "ARCA", ...quote } as Quote),
  });
  const closes = (points: PricePoint[]) => points.filter((point) => new Date(point.date).getUTCHours() === 19).map((point) => point.close);
  const earlier = [378.65, 379.65, 380.65, 381.65, 382.65];
  const request = (now: string) => ({ symbol: "VTI", exchange: "", range: "5D" as const, resolution: "1h" as const, support: [], now: Date.parse(now) });

  // Sunday: the quote's official close of Friday's session.
  const sunday = await loadReturnSeries(provider({ marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T23:59:00Z"),
    regularClose: 384, regularCloseSessionDate: "2026-10-09" }), request("2026-10-11T15:00:00Z"));
  expect(closes(sunday.points)).toEqual([...earlier, 384]);
  expect(sunday.closingPrintPending).toBeUndefined();
  // A weekend quote without it: Friday's daily bar, and no note that a print is to come.
  const weekend = await loadReturnSeries(provider({ marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T23:59:00Z") }), request("2026-10-11T15:00:00Z"));
  expect(closes(weekend.points)).toEqual([...earlier, 383.65]);
  expect(weekend.closingPrintPending).toBeUndefined();
  // Right after the close, before the print: the last trade stays, and the note says the print is to come.
  const justClosed = await loadReturnSeries(provider({ marketState: "POST", lastUpdated: Date.parse("2026-10-09T20:05:00Z") }), request("2026-10-09T20:10:00Z"));
  expect(closes(justClosed.points).at(-1)).toBeCloseTo(383.6);
  expect(justClosed.closingPrintPending).toBe("2026-10-09");
});

test("a daily close is the session of its venue's local date, not of its UTC date", async () => {
  // BHP on the ASX: Sydney's 10:00 to 16:00 session runs 23:00 to 05:00 UTC, so Thursday's daily bar is stamped
  // 23:00 UTC on Wednesday and its last hourly bar opens at 04:00 UTC on Thursday.
  const sessions = [["2026-10-28", "2026-10-29"], ["2026-10-29", "2026-10-30"]] as const;
  const hourly: PricePoint[] = sessions.flatMap(([eve, day], session) => [
    { date: new Date(`${eve}T23:00:00Z`), close: 45 + session },
    ...[0, 1, 2, 3, 4].map((hour) => ({ date: new Date(`${day}T0${hour}:00:00Z`), close: 45.1 + session + hour / 100 })),
  ]);
  const daily: PricePoint[] = [{ date: new Date("2026-10-28T23:00:00Z"), close: 45.5 }, { date: new Date("2026-10-29T23:00:00Z"), close: 46.5 }];
  const provider = createTestDataProvider({
    getDetailedPriceHistoryWithMetadata: async (_symbol, _exchange, _start, _end, interval) => (
      interval === "1d" ? { points: daily, resolution: "1d" } : { points: hourly, resolution: "1h" }),
    getQuote: async (symbol) => ({ symbol, price: 46.5, change: 0, changePercent: 0, currency: "AUD", listingExchangeName: "ASX",
      marketState: "CLOSED", lastUpdated: Date.parse("2026-10-30T06:00:00Z") }),
  });
  const series = await loadReturnSeries(provider, { symbol: "BHP", exchange: "ASX", range: "5D", resolution: "1h", support: [],
    now: Date.parse("2026-10-31T03:00:00Z") });
  const lastBars = series.points.filter((point) => new Date(point.date).getUTCHours() === 4).map((point) => point.close);
  expect(lastBars).toEqual([45.5, 46.5]);
});
