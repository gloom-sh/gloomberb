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
