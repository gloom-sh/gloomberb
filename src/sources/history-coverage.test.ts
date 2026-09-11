import { expect, test } from "bun:test";
import { applyYahooHistoryCoverage } from "./history-coverage";
import { fetchYahooChart } from "./yahoo-finance/requests";
import type { YahooHttpClient } from "./yahoo-finance/http";

const meta = { symbol: "SHEL.L", exchangeName: "LSE", currency: "GBp" };
const point = (date: string, close: number) => ({ date: new Date(date), close });

test("the shared Yahoo request boundary removes spanning OHLC and retains source provenance", async () => {
  const raw = { chart: { result: [{ meta: { ...meta, dataGranularity: "1wk" },
    timestamp: [Date.parse("2005-07-18T07:00:00Z") / 1000, Date.parse("2005-07-25T07:00:00Z") / 1000],
    indicators: { quote: [{ open: [1829.5, 1764], high: [1845, 1776], low: [1720, 1701], close: [1748, 1747], volume: [42, 58] }] },
  }] } };
  const http = { fetchJson: async () => structuredClone(raw) } as unknown as YahooHttpClient;
  const chart = await fetchYahooChart(http, "SHEL.L", "max", "1wk");
  expect(chart.history).toHaveLength(1);
  expect(chart.history[0]).toMatchObject({ open: 1764, high: 1776, low: 1701, close: 1747, volume: 58,
    historySource: { provider: "yahoo", symbol: "SHEL", exchange: "LSE", currency: "GBP", verifiedLineageStart: "2005-07-21" } });
  expect(raw.chart.result[0]!.timestamp).toHaveLength(2);
});

test("daily and monthly coverage excludes earlier bars without altering retained observations", () => {
  const daily = [point("1997-06-30", 6389.35986328125), point("1997-07-01", 1805.6500244140625),
    point("2005-07-20", 1766.5), point("2005-07-21", 1753), point("2026-09-10", 3533)];
  expect(applyYahooHistoryCoverage("SHEL.L", meta, "1d", daily).map((p) => p.close)).toEqual([1753, 3533]);
  expect(applyYahooHistoryCoverage("SHEL.L", meta, "1mo", [point("2005-07-01", 1747), point("2005-08-01", 1800)])
    .map((p) => p.close)).toEqual([1800]);
  expect(() => applyYahooHistoryCoverage("SHEL.L", meta, "1d", daily.slice(0, 2))).toThrow("earlier share lineage is unverified");
  expect(daily).toHaveLength(5);
});

test("foreign and US listings, other issuers, and intraday observations remain untouched", () => {
  const points = [point("1997-06-30", 123), point("2026-09-10", 456)];
  for (const symbol of ["SHEL", "SHELL.AS", "BP.L"]) expect(applyYahooHistoryCoverage(symbol, meta, "1d", points)).toBe(points);
  expect(applyYahooHistoryCoverage("SHEL.L", meta, "5m", points)).toBe(points);
  for (const invalid of [{ ...meta, symbol: "SHEL" }, { ...meta, currency: "USD" },
    { ...meta, exchangeName: "AMS" }, { symbol: "SHEL.L", currency: "GBp" }]) {
    expect(() => applyYahooHistoryCoverage("SHEL.L", invalid, "1d", points)).toThrow("identity");
  }
});
