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
