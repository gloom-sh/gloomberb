import { afterEach, expect, setSystemTime, test } from "bun:test";
import { YahooFinanceClient } from "../yahoo-finance";
import { YahooHttpClient } from "./http";
import { fetchYahooChart } from "./requests";
import { loadYahooPriceHistoryForResolutionWithMetadata } from "./history";
import { regularHistorySessionStaleness } from "../../market-data/history-session";
import capture from "./fixtures/aapl-final-observation.json";

afterEach(() => setSystemTime());
const NOW = Date.parse(capture.observedAt);
function source(mutate?: (result: typeof capture.chart.result[0]) => void) {
  const value = structuredClone(capture);
  mutate?.(value.chart.result[0]!);
  const calls: URL[] = [];
  const http = new YahooHttpClient();
  http.fetchJson = async <T>(url: string) => { calls.push(new URL(url)); return value as T; };
  return { provider: new YahooFinanceClient(http), http, calls, value };
}

test("saved Yahoo final observation survives native history with its actual source convention", async () => {
  setSystemTime(NOW);
  const { provider, calls } = source();
  const result = await provider.getPriceHistoryWithMetadata("AAPL", "NASDAQ", "1M");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.searchParams.get("includePrePost")).toBe("false");
  expect(calls[0]!.searchParams.get("interval")).toBe("15m");
  expect(result.points.map(point => point.close)).toEqual(capture.chart.result[0]!.indicators.quote[0]!.close);
  expect(result.points.map(point => point.volume)).toEqual(capture.chart.result[0]!.indicators.quote[0]!.volume);
  expect(result.session).toMatchObject({ symbol: "AAPL", exchange: "NASDAQ", interval: "15min", source: "yahoo",
    timestampConvention: "bar-open-with-final-observation", observedAt: NOW });
  expect(regularHistorySessionStaleness(result.points.at(-1)!.date.getTime(), NOW, result.session!)).toBe(false);
  const arrays = await provider.getPriceHistory("AAPL", "NASDAQ", "1M");
  expect(calls).toHaveLength(2); // One acquisition per public call, including compatibility projections.
  expect(arrays).toEqual(result.points);
  expect("getDetailedPriceHistoryWithMetadata" in provider).toBe(false);
  expect("getDetailedPriceHistory" in provider).toBe(false);
});

test("native regular candles retain acquisition time and do not gain freshness when a result is reused", async () => {
  setSystemTime(NOW);
  const { http } = source(result => {
    result.timestamp.pop();
    for (const values of Object.values(result.indicators.quote[0]!)) values.pop();
  });
  const acquisition = await fetchYahooChart(http, "AAPL", "1mo", "15m");
  setSystemTime(NOW + 3_600_000);
  const result = await loadYahooPriceHistoryForResolutionWithMetadata({ ticker: "AAPL", exchange: "NASDAQ",
    bufferRange: "1M", resolution: "15m", fetchChart: async () => acquisition });
  expect(result.session).toMatchObject({ timestampConvention: "bar-open", observedAt: NOW });
});

test("native final-observation proof cannot use a quote later than its acquisition", async () => {
  const quoteTime = capture.chart.result[0]!.meta.regularMarketTime * 1000;
  for (const observedAt of [quoteTime - 1000, quoteTime]) {
    setSystemTime(observedAt);
    const result = await source().provider.getPriceHistoryWithMetadata("AAPL", "NASDAQ", "1M");
    expect(result.points).toHaveLength(4);
    if (observedAt < quoteTime) expect(result.session).toBeUndefined();
    else expect(result.session).toMatchObject({ timestampConvention: "bar-open-with-final-observation", observedAt });
  }
});

test("native metadata requires exact source identity, cadence, calendar and final-observation proof", async () => {
  setSystemTime(NOW);
  for (const mutate of [
    (r: typeof capture.chart.result[0]) => { r.meta.symbol = "MSFT"; },
    (r: typeof capture.chart.result[0]) => { r.meta.instrumentType = "INDEX"; },
    (r: typeof capture.chart.result[0]) => { r.meta.currency = "CAD"; },
    (r: typeof capture.chart.result[0]) => { r.meta.exchangeName = "NYQ"; },
    (r: typeof capture.chart.result[0]) => { r.meta.fullExchangeName = "LSE"; },
    (r: typeof capture.chart.result[0]) => { r.meta.exchangeTimezoneName = "Europe/London"; },
    (r: typeof capture.chart.result[0]) => { r.meta.regularMarketTime -= 60; },
    (r: typeof capture.chart.result[0]) => { r.meta.regularMarketPrice = 100; },
    (r: typeof capture.chart.result[0]) => { r.timestamp[3]! += 60; },
  ]) {
    const { provider } = source(mutate);
    const result = await provider.getPriceHistoryForResolutionWithMetadata("AAPL", "NASDAQ", "1M", "15m");
    expect(result.session).toBeUndefined();
    expect(result.points).toHaveLength(4);
  }
  const wrongCadence = source(r => { r.meta.dataGranularity = "1h"; });
  await expect(wrongCadence.provider.getPriceHistoryForResolutionWithMetadata("AAPL", "NASDAQ", "1M", "15m"))
    .rejects.toThrow("Yahoo returned 1h bars");
  const { http } = source();
  const extended = await fetchYahooChart(http, "AAPL", "1mo", "15m", true);
  expect((await loadYahooPriceHistoryForResolutionWithMetadata({ ticker: "AAPL", exchange: "NASDAQ",
    bufferRange: "1M", resolution: "15m", fetchChart: async () => extended })).session).toBeUndefined();
  setSystemTime(Date.parse("2027-01-05T12:00:00Z"));
  expect((await source().provider.getPriceHistoryWithMetadata("AAPL", "NASDAQ", "1M")).session).toBeUndefined();
});

test("a verified listed ETF has equity-market hours without borrowing its underlying asset calendar", async () => {
  setSystemTime(NOW);
  const { provider } = source(r => {
    r.meta.symbol = "SGOV"; r.meta.instrumentType = "ETF";
    r.meta.exchangeName = "PCX"; r.meta.fullExchangeName = "NYSEArca";
  });
  expect((await provider.getPriceHistoryForResolutionWithMetadata("SGOV", "ARCA", "1M", "15m")).session?.kind).toBe("regular");
});

test("native opening bars retain their exact cadence through ordinary and published early closes", async () => {
  for (const [resolution, times, now] of [
    ["1m", ["2026-09-21T19:58:00Z", "2026-09-21T19:59:00Z"], NOW],
    ["5m", ["2026-09-21T19:50:00Z", "2026-09-21T19:55:00Z"], NOW],
    ["1h", ["2026-09-21T18:30:00Z", "2026-09-21T19:30:00Z"], NOW],
    ["15m", ["2026-11-27T17:30:00Z", "2026-11-27T17:45:00Z"], Date.parse("2026-11-30T12:00:00Z")],
  ] as const) {
    setSystemTime(now);
    const { provider } = source(r => {
      r.meta.dataGranularity = resolution === "1h" ? "60m" : resolution;
      r.timestamp = times.map(time => Date.parse(time) / 1000);
      r.indicators.quote = [{ close: [100, 101], open: [100, 100], high: [100, 101], low: [100, 100], volume: [11, 22] }];
    });
    const result = await provider.getPriceHistoryForResolutionWithMetadata("AAPL", "NASDAQ", "1M", resolution);
    expect(result.resolution).toBe(resolution);
    expect(result.session?.timestampConvention).toBe("bar-open");
    expect(result.points.map(point => point.date.toISOString())).toEqual(times.map(time => new Date(time).toISOString()));
    expect(regularHistorySessionStaleness(result.points.at(-1)!.date.getTime(), now, result.session!)).toBe(false);
  }
});
