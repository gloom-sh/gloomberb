import { expect, test } from "bun:test";
import { fetchYahooChart } from "./requests";
import type { YahooHttpClient } from "./http";

function chart(granularity: unknown) {
  return { chart: { result: [{ meta: { symbol: "MSFT", currency: "USD", dataGranularity: granularity },
    timestamp: [Date.parse("1965-01-01") / 1000, Date.parse("2026-08-01") / 1000],
    indicators: { quote: [{ open: [2, 4], high: [4, 6], low: [1, 3], close: [3, 5], volume: [12, 34] }] },
  }] } };
}
function http(raw: unknown, urls: URL[]) {
  return { fetchJson: async (url: string) => { urls.push(new URL(url)); return structuredClone(raw); } } as unknown as YahooHttpClient;
}

test("native full history requests explicit bounds and retains exact prices and pre-1970 source dates", async () => {
  const urls: URL[] = [];const raw = chart("1mo");
  const result = await fetchYahooChart(http(raw, urls), "MSFT", "max", "1mo");
  expect(urls[0]!.searchParams.has("range")).toBe(false);
  expect(Number(urls[0]!.searchParams.get("period1"))).toBeLessThan(Date.parse("1965-01-01") / 1000);
  expect(Number(urls[0]!.searchParams.get("period2"))).toBeGreaterThan(Date.now() / 1000 - 10);
  expect(result.history.map((p) => p.date.toISOString().slice(0, 10))).toEqual(["1965-01-01", "2026-08-01"]);
  expect(result.history.map((p) => [p.open, p.high, p.low, p.close, p.volume])).toEqual([[2, 4, 1, 3, 12], [4, 6, 3, 5, 34]]);
  expect(raw.chart.result[0]!.indicators.quote[0]!.close).toEqual([3, 5]);
});

test("native history rejects weekly or quarterly data mislabeled as monthly, and missing cadence", async () => {
  for (const served of ["1wk", "3mo", "1d", undefined]) {
    await expect(fetchYahooChart(http(chart(served), []), "SHIB-USD", "max", "1mo")).rejects.toThrow("requested 1mo");
  }
});

test("finite windows preserve range and equivalent hourly cadence is accepted", async () => {
  const urls: URL[] = [];
  await fetchYahooChart(http(chart("60m"), urls), "MSFT", "1mo", "1h");
  expect(urls[0]!.searchParams.get("range")).toBe("1mo");
  expect(urls[0]!.searchParams.has("period1")).toBe(false);
});

test("the current period is completed from the chart's own regular-market facts", async () => {
  // NVDA as Yahoo served it before the open on 2026-09-23.
  const meta = { symbol: "NVDA", currency: "USD", regularMarketPrice: 228.87, regularMarketChangePercent: 0.655,
    regularMarketTime: Date.parse("2026-09-22T20:00:00Z") / 1000 };
  const live = { t: "2026-09-22T20:00:00Z", o: 226.91, h: 229.98, l: 226.5, c: 228.87, v: 93296546 };
  const served = (granularity: string, rows: Array<typeof live | { t: string; o: number; h: number; l: number; c: number | null; v: number }>) => ({
    chart: { result: [{ meta: { ...meta, dataGranularity: granularity }, timestamp: rows.map((row) => Date.parse(row.t) / 1000),
      indicators: { quote: [{ open: rows.map((row) => row.o), high: rows.map((row) => row.h), low: rows.map((row) => row.l),
        close: rows.map((row) => row.c), volume: rows.map((row) => row.v) }] } }] } });
  const bars = async (granularity: string, rows: Parameters<typeof served>[1]) =>
    (await fetchYahooChart(http(served(granularity, rows), []), "NVDA", "3mo", granularity)).history
      .map((p) => [p.date.toISOString().slice(0, 10), p.high, p.low, p.close, p.volume]);

  // Yahoo leaves the finished session's daily close empty for hours.
  expect(await bars("1d", [{ t: "2026-09-21T13:30:00Z", o: 222.94, h: 228.5, l: 221.56, c: 227.38, v: 109806100 },
    { ...live, t: "2026-09-22T13:30:00Z", c: null }, { t: "2026-09-23T13:30:00Z", o: 0, h: 0, l: 0, c: null, v: 0 }]))
    .toEqual([["2026-09-21", 228.5, 221.56, 227.38, 109806100], ["2026-09-22", 229.98, 226.5, 228.87, 93296546]]);
  // The weekly row stops at Monday; the trailing observation is Tuesday.
  expect(await bars("1wk", [{ t: "2026-09-21T04:00:00Z", o: 222.94, h: 228.5, l: 221.56, c: 227.38, v: 109806100 }, live]))
    .toEqual([["2026-09-21", 229.98, 221.56, 228.87, 203102646]]);
  // Mid-session the row can already hold part of Tuesday: newer prices, never Tuesday's volume twice.
  expect(await bars("1wk", [{ t: "2026-09-21T04:00:00Z", o: 222.94, h: 229.5, l: 221.56, c: 228.4, v: 150000000 }, live]))
    .toEqual([["2026-09-21", 229.98, 221.56, 228.87, 150000000]]);
  // The monthly row already includes it.
  expect(await bars("1mo", [{ t: "2026-09-01T04:00:00Z", o: 216.75, h: 234.76, l: 208.93, c: 228.87, v: 1744259600 }, live]))
    .toEqual([["2026-09-01", 234.76, 208.93, 228.87, 1744259600]]);
});
