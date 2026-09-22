import { afterEach, expect, setSystemTime, test } from "bun:test";
import { apiClient, type CloudMarketResponse, type CloudPricePointPayload } from "../../api-client";
import { CloudDataApi } from "../../api-client/data";
import type { HistorySession } from "../../types/price-history";
import { GloomberbCloudProvider } from "./index";

const originalHistory = apiClient.getCloudHistory;
afterEach(() => { apiClient.getCloudHistory = originalHistory; setSystemTime(); });
const NOW = Date.parse("2026-09-22T12:42:12Z");
const session = (interval = "15min"): HistorySession => ({ version: 1, kind: "regular", calendar: "us-equity",
  timeZone: "America/New_York", symbol: "AAPL", exchange: "NASDAQ", interval, source: "yahoo",
  timestampConvention: "bar-open", barAlignment: "session-open", observedAt: NOW - 60_000 });
const points: CloudPricePointPayload[] = [{ date: "2026-09-21T19:45:00Z", open: 339.19, high: 339.64,
  low: 338.81, close: 338.8900146484375, volume: 2218511 }];
type Envelope = CloudMarketResponse<CloudPricePointPayload[]>;
function wire(handler: (url: URL) => Envelope): URL[] {
  const calls: URL[] = [];
  const api = new CloudDataApi(async <T>(path: string) => {
    const url = new URL(path, "https://controlled.invalid"); calls.push(url);
    return JSON.parse(JSON.stringify(handler(url))) as T;
  });
  apiClient.getCloudHistory = api.getCloudHistory.bind(api);
  return calls;
}

test("Cloud metadata methods keep one acquisition, source observation time and source-declared default cadence", async () => {
  setSystemTime(NOW);
  const calls = wire(url => ({ status: "success", data: points, historySession: session(url.searchParams.get("interval")!),
    providerMeta: { provider: "cache" } }));
  const provider = new GloomberbCloudProvider();
  const start = new Date("2026-09-14T00:00:00Z"), end = new Date(NOW);
  const detailed = await provider.getDetailedPriceHistoryWithMetadata("AAPL", "NASDAQ", start, end, "15m");
  expect(calls).toHaveLength(1);
  expect(detailed.session).toEqual(session());
  expect(detailed.resolution).toBe("15m");
  expect(detailed.points[0]).toEqual({ ...points[0]!, date: new Date(points[0]!.date) });
  expect(await provider.getDetailedPriceHistory("AAPL", "NASDAQ", start, end, "15m")).toEqual(detailed.points);
  expect(calls).toHaveLength(2);
  const resolution = await provider.getPriceHistoryForResolutionWithMetadata("AAPL", "NASDAQ", "1M", "15m");
  expect(resolution).toEqual(detailed);
  expect(calls).toHaveLength(3);
  const ranged = await provider.getPriceHistoryWithMetadata("AAPL", "NASDAQ", "1W");
  expect(ranged.resolution).toBe("1h");
  expect(ranged.session?.observedAt).toBe(NOW - 60_000);
  expect(calls).toHaveLength(4);
});

test("absent Cloud metadata remains compatible but contradictory declarations reject the acquisition", async () => {
  setSystemTime(NOW);
  const provider = new GloomberbCloudProvider();
  wire(() => ({ status: "success", data: points }));
  const legacy = await provider.getPriceHistoryForResolutionWithMetadata("AAPL", "NASDAQ", "1M", "15m");
  expect(legacy.session).toBeUndefined();
  expect(legacy.points[0]?.close).toBe(points[0]!.close);
  for (const patch of [null, {}, { ...session(), symbol: "MSFT" }, { ...session(), exchange: "NYSE" },
    { ...session(), interval: "5min" }, { ...session(), observedAt: NOW + 1 },
    { ...session(), source: "unverified" }, { ...session(), calendar: "crypto" }]) {
    wire(() => ({ status: "success", data: points, historySession: patch }));
    await expect(provider.getPriceHistoryForResolutionWithMetadata("AAPL", "NASDAQ", "1M", "15m"))
      .rejects.toThrow("session metadata does not match");
  }
  for (const providerMeta of [{ provider: "twelvedata" }, { normalizedSymbol: "MSFT" },
    { provider: "cache", upstream: "twelvedata" },
    { normalizedExchange: "LSE" }, { currency: "CAD" }, { servedResolution: "5min" },
    { requestedResolution: "1day", servedResolution: "15min" }]) {
    wire(() => ({ status: "success", data: points, historySession: session(), providerMeta }));
    await expect(provider.getDetailedPriceHistory("AAPL", "NASDAQ", new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-20T00:00:00Z"), "15m")).rejects.toThrow("session metadata does not match");
  }
});
