import { expect, test } from "bun:test";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { historicalIntradayClose } from "./session-history";

test("a sparse historic ETF session uses only its verified same-basis daily close", async () => {
  const sourceKey = "provider:test";
  const day = "2026-10-30";
  const print = { date: new Date(`${day}T19:38:00Z`), close: 12.31, volume: 811 };
  const daily = { date: new Date(day), close: 12.19 };
  const now = Date.parse("2026-11-28T06:05:00Z");
  const window = { symbol: "BDRY", exchange: "ARCA", points: [print], sourceKey,
    quote: createTestQuote({ symbol: "BDRY", instrumentType: "ETF", regularClose: 12.84, regularCloseSessionDate: "2026-11-27" }) };
  for (const state of ["verified", "missing", "partial", "stale", "wrong-date", "other-source", "other-units"] as const) {
    const market = createTestDataProvider({ getDetailedPriceHistoryWithMetadata: async (_symbol, _exchange, _start, _end, interval) => {
      expect(interval).toBe("1d");
      const row = state === "partial" ? { ...daily, partial: true } : state === "wrong-date"
        ? { ...daily, date: new Date("2026-10-29") } : state === "other-units" ? { ...daily, close: 1219 } : daily;
      return { resolution: "1d", points: state === "missing" ? [] : [row], sourceKey: state === "other-source" ? "provider:other" : sourceKey,
        ...(state === "stale" ? { savedCopyBehind: true } : {}) };
    } });
    const result = await historicalIntradayClose(market, window, day, now);
    if (state === "verified") {
      expect(result?.mark).toEqual({ date: new Date(`${day}T20:00:00Z`), close: 12.19, sessionClose: true });
    } else {
      expect(result?.mark).toBeUndefined();
      expect(result?.note).toContain("last regular print 19:38 UTC; official close unavailable");
    }
    expect(result?.lastAt).toBe(+print.date);
  }
  expect(await historicalIntradayClose(createTestDataProvider(), {
    ...window, quote: createTestQuote({ ...window.quote, lastUpdated: Date.parse("2026-11-27T18:00:00Z") }),
  }, "2026-11-27", now)).toBeNull();
});
