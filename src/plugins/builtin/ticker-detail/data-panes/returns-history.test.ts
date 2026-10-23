import { expect, test } from "bun:test";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import type { PricePoint } from "../../../../types/financials";
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
  expect(asked).toEqual([{ start: "2026-09-30T20:00:00.000Z", end: "2026-10-11T15:00:00.000Z" }]);
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
