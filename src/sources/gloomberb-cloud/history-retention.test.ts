import { afterEach, expect, setSystemTime, test } from "bun:test";
import { apiClient, type CloudMarketResponse, type CloudPricePointPayload } from "../../api-client";
import { CloudDataApi } from "../../api-client/data";
import { ApiRequestError } from "../../api-client/errors";
import type { MarketDataRequestContext } from "../../types/data-provider";
import type { TickerFinancials } from "../../types/financials";
import { ChartResolveCache, resolveChartSpecData } from "../../time-series/resolve";
import type { ChartSpec } from "../../time-series/types";
import { HistoryRetentionError, type HistoryRecoveryCandidate, type HistoryRetention } from "../history-retention";
import { AssetDataRouter } from "../provider-router";
import { fallbackProvider } from "../provider-router/test-support";
import { GloomberbCloudProvider } from "./index";
import { formatCloudDateTime } from "./normalizers";

const originalHistory = apiClient.getCloudHistory;
const originalQuote = apiClient.getCloudQuote;
afterEach(() => { apiClient.getCloudHistory = originalHistory; apiClient.getCloudQuote = originalQuote; setSystemTime(); });
const DAY = 86_400_000;
type Envelope = CloudMarketResponse<CloudPricePointPayload[]>;
const proof = (patch: Partial<HistoryRetention> = {}): HistoryRetention => {
  const observedAt = Math.floor(Date.now() / 1000) * 1000;
  return { version: 1, source: "yahoo", symbol: "BTC-USD", exchange: "CCC", interval: "15min",
    requestedStart: observedAt - 90 * DAY, requestedEnd: observedAt, observedAt, availableStart: observedAt - 60 * DAY, ...patch };
};
const unsupported = (retention: HistoryRetention): Envelope => ({ status: "unsupported", data: null, reasonCode: "HISTORY_RETENTION", historyRetention: retention });
const success = (): Envelope => ({ status: "success", providerMeta: { provider: "yahoo" },
  data: [{ date: new Date(Date.now() - 900_000).toISOString(), close: 100 }] });
function wire(handler: (url: URL) => Envelope | Promise<Envelope>): URL[] {
  const calls: URL[] = [];
  const api = new CloudDataApi(async <T>(path: string) => {
    const url = new URL(path, "https://controlled.invalid"); calls.push(url);
    return JSON.parse(JSON.stringify(await handler(url))) as T;
  });
  apiClient.getCloudHistory = api.getCloudHistory.bind(api);
  return calls;
}
const detail = (provider: GloomberbCloudProvider | AssetDataRouter, retention: HistoryRetention, context?: MarketDataRequestContext) =>
  provider.getDetailedPriceHistory(retention.symbol, retention.exchange, new Date(retention.requestedStart), new Date(retention.requestedEnd), "15m", context);

test("Cloud/API original evidence survives routing and only the public proof is serialized for selected recovery", async () => {
  const data = proof(), calls = wire((url) => url.searchParams.has("historyRecovery") ? success() : unsupported(data));
  const otherCalls: string[] = [];
  const router = new AssetDataRouter(new GloomberbCloudProvider(), [401, 429, 503].map((status) => ({
    ...fallbackProvider, id: `status-${status}`, priority: 200,
    async getDetailedPriceHistory() { otherCalls.push(`status-${status}`); throw new ApiRequestError("Controlled failure", status, 2000); },
  })));
  const context = { instrument: { brokerId: "ibkr", brokerInstanceId: "research-account", symbol: "BTC", conId: 1123 } };
  const failure = await detail(router, data, context).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(HistoryRetentionError);
  const typed = failure as HistoryRetentionError;
  expect(typed.outcomes.map((outcome) => outcome.outcome).sort()).toEqual(["auth", "rate-limit", "retention", "transient"]);
  const candidate = typed.candidates[0]!;
  expect(candidate.request).toMatchObject({ entityKey: "contract:1123", brokerId: "ibkr", brokerInstanceId: "research-account" });
  const result = await router.getDetailedPriceHistory("BTC-USD", "CCC", new Date(data.availableStart), new Date(data.requestedEnd), "15m", { ...context, historyRecovery: candidate });
  expect(result[0]?.close).toBe(100);
  expect(otherCalls.sort()).toEqual(["status-401", "status-429", "status-503"]);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.searchParams.has("historyRecovery")).toBe(false);
  expect(calls[0]!.searchParams.get("startDate")).toBe(formatCloudDateTime(new Date(data.requestedStart), true, "CCC"));
  const retry = calls[1]!.searchParams;
  expect(JSON.parse(retry.get("historyRecovery")!)).toEqual(data);
  expect([...retry.keys()].sort()).toEqual(["endDate", "exchange", "historyRecovery", "interval", "startDate", "symbol"]);
  expect(calls[1]!.href).not.toContain("research-account");
  expect(retry.get("startDate")).toBe(formatCloudDateTime(new Date(data.availableStart), true, "CCC"));
});

test("Cloud validates exact original bounds and rejects malformed or non-retention envelopes", async () => {
  const data = proof(), provider = new GloomberbCloudProvider();
  const cases: Envelope[] = [
    ...[{ symbol: "ETH-USD" }, { exchange: "NASDAQ" }, { interval: "1h" }, { interval: "2min" },
      { requestedStart: data.requestedStart + 1000 }, { requestedEnd: data.requestedEnd + 1000 },
      { observedAt: data.observedAt + 1000, availableStart: data.availableStart + 1000 },
      { observedAt: data.observedAt - 301_000, availableStart: data.availableStart - 301_000 },
      { availableStart: data.availableStart + 1000 }, { availableStart: data.observedAt - 731 * DAY },
    ].map((patch) => unsupported({ ...data, ...patch })),
    { ...unsupported(data), historyRetention: null },
    { ...unsupported(data), reasonCode: "UNSUPPORTED_RANGE" },
    { ...unsupported(data), status: "empty" },
    { ...unsupported(data), stale: true },
    { ...unsupported(data), providerMeta: { stale: true } },
  ];
  for (const envelope of cases) {
    wire(() => envelope);
    const result = await detail(provider, data).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(HistoryRetentionError);
  }
  wire(() => unsupported(data));
  const result = await provider.getDetailedPriceHistory(data.symbol, data.exchange, new Date(data.requestedStart + 987), new Date(data.requestedEnd + 456), "15m").catch((error: unknown) => error);
  expect(result).toBeInstanceOf(HistoryRetentionError);
  expect((result as HistoryRetentionError).retention).toEqual(data);
});

test("trailing resolver acquisition shares source-computed Cloud recovery across price, volume and study edits", async () => {
  const now = Date.parse("2026-09-22T12:00:00Z"), step = 900_000;
  setSystemTime(now);
  let original: HistoryRetention | undefined;
  let retainedPoints: CloudPricePointPayload[] = [];
  const calls = wire((url) => {
    if (url.searchParams.has("historyRecovery")) {
      const start = Date.parse(url.searchParams.get("startDate")!.replace(" ", "T") + "Z");
      retainedPoints = Array.from({ length: Math.floor((now - start) / step) + 1 }, (_, index) => ({
        date: new Date(start + index * step).toISOString(), close: 100 + index, volume: 1 + index,
      }));
      return { status: "success", providerMeta: { provider: "yahoo" }, data: retainedPoints };
    }
    original = proof({
      requestedStart: Date.parse(url.searchParams.get("startDate")!.replace(" ", "T") + "Z"),
      requestedEnd: Date.parse(url.searchParams.get("endDate")!.replace(" ", "T") + "Z"),
    });
    return unsupported(original);
  });
  apiClient.getCloudQuote = async () => ({ status: "success", data: { symbol: "BTC-USD", listingExchangeName: "CCC", currency: "USD",
    instrumentType: "CRYPTOCURRENCY", price: 100, change: 0, changePercent: 0, lastUpdated: now, providerId: "gloomberb-cloud" } });
  const router = new AssetDataRouter(new GloomberbCloudProvider());
  const spec: ChartSpec = { version: 2, viewport: { range: "1M", resolution: "auto" }, panels: [{ id: "main" }], studies: [],
    series: ["close", "volume"].map((field) => ({ id: field,
      source: { kind: "security", instrument: { symbol: "BTC-USD", exchange: "CCC" }, fieldId: `market.${field}` },
      style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" })),
  };
  const captures: TickerFinancials[] = [], cache = new ChartResolveCache();
  const sources = { dataProvider: router, now: new Date(now), loadFredSeries: async () => { throw Error("No FRED in this fixture"); },
    onSecurityData: (_spec: unknown, value: TickerFinancials) => captures.push(value) };
  const result = await resolveChartSpecData(spec, sources, cache, { awaitResolutionSupport: true });
  expect(result.errors).toEqual([]);
  expect(result.resolution).toBe("15m");
  expect(result.series.map((series) => series.historyResolution)).toEqual(["15m", "15m"]);
  expect(captures.every((capture) => capture.priceHistoryResolution === "15m")).toBe(true);
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[1]!.searchParams.get("historyRecovery")!)).toEqual(original!);
  expect(Date.parse(calls[1]!.searchParams.get("startDate")!.replace(" ", "T") + "Z")).toBe(original!.availableStart + step);
  spec.studies = [{ id: "sma", kind: "sma", inputSeriesIds: ["close"], parameters: { period: 200 }, panelId: "main", axis: "left" }];
  const studied = await resolveChartSpecData(spec, { ...sources, now: new Date(now + 1000) }, cache, { awaitResolutionSupport: true });
  expect(studied.errors).toEqual([]);
  expect(calls).toHaveLength(2);
  const first = studied.series.find((series) => series.id === "close")!.points[0]!;
  const index = retainedPoints.findIndex((point) => Date.parse(point.date) === +first.date);
  expect(index).toBeGreaterThanOrEqual(199);
  expect(studied.series.find((series) => series.id === "sma")!.points[0]!.value)
    .toBeCloseTo(retainedPoints.slice(index - 199, index + 1).reduce((sum, point) => sum + point.close, 0) / 200, 10);
});

test("qualified listing and instrument-preferred scope remain bound across Cloud recovery", async () => {
  const data = proof({ symbol: "ASML", exchange: "NASDAQ" });
  for (const context of [undefined, { brokerId: "unused", brokerInstanceId: "unused", instrument: {
    brokerId: "ibkr", brokerInstanceId: "research-account", symbol: "ASML", conId: 123,
  } }]) {
    const calls = wire((url) => url.searchParams.has("historyRecovery") ? success() : unsupported(data));
    const router = new AssetDataRouter(new GloomberbCloudProvider());
    const failure = await router.getDetailedPriceHistory("ASML:XNAS", "NASDAQ", new Date(data.requestedStart), new Date(data.requestedEnd), "15m", context).catch((error: unknown) => error) as HistoryRetentionError;
    expect(failure).toBeInstanceOf(HistoryRetentionError);
    const candidate = failure.candidates[0]!;
    expect(candidate.request.entityKey).toBe(context ? "contract:123" : "ASML:XNAS");
    expect((await router.getDetailedPriceHistory("ASML:XNAS", "NASDAQ", new Date(data.availableStart), new Date(data.requestedEnd), "15m", { ...context, historyRecovery: candidate }))[0]?.close).toBe(100);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.searchParams.get("symbol")).toBe("ASML");
  }
});

test("direct Cloud recovery refuses altered identity, scope and invalid or expanding raw dates before transport", async () => {
  const data = proof();
  const candidate: HistoryRecoveryCandidate = { sourceKey: "provider:gloomberb-cloud", retention: data, request: {
    symbol: data.symbol, exchange: data.exchange, interval: data.interval, entityKey: "contract:123", brokerId: "ibkr", brokerInstanceId: "research-account",
    requestedStart: data.requestedStart, requestedEnd: data.requestedEnd,
  } };
  const context = { instrument: { brokerId: "ibkr", brokerInstanceId: "research-account", symbol: "BTC", conId: 123 }, historyRecovery: candidate };
  const calls = wire(() => success()), provider = new GloomberbCloudProvider();
  const retry = (start = new Date(data.availableStart), end = new Date(data.requestedEnd), ctx: MarketDataRequestContext = context) =>
    provider.getDetailedPriceHistory("BTC-USD", "CCC", start, end, "15m", ctx);
  for (const invalid of [
    { ...candidate, sourceKey: "provider:another" },
    { ...candidate, request: { ...candidate.request, entityKey: "contract:456" } },
    { ...candidate, request: { ...candidate.request, brokerId: "other" } },
    { ...candidate, request: { ...candidate.request, brokerInstanceId: "other" } },
    { ...candidate, request: { ...candidate.request, interval: "1h" } },
  ]) await expect(retry(undefined, undefined, { ...context, historyRecovery: invalid })).rejects.toThrow("Invalid history recovery");
  for (const [start, end] of [[NaN, data.requestedEnd], [data.availableStart, NaN], [data.availableStart - 1, data.requestedEnd],
    [data.availableStart, data.requestedEnd + 1], [data.requestedEnd, data.requestedEnd], [data.requestedStart, data.requestedEnd],
  ]) await expect(retry(new Date(start!), new Date(end!))).rejects.toThrow("Invalid history recovery");
  await expect(provider.getPriceHistory("BTC-USD", "CCC", "3M", context)).rejects.toThrow("requires exact bounds");
  await expect(provider.getPriceHistoryForResolution("BTC-USD", "CCC", "3M", "15m", context)).rejects.toThrow("requires exact bounds");
  expect(calls).toHaveLength(0);
  expect((await retry())[0]?.close).toBe(100);
  expect(calls).toHaveLength(1);
});

test("Cloud/API transport errors keep status and retry timing", async () => {
  const data = proof(), provider = new GloomberbCloudProvider();
  for (const status of [401, 429, 503]) {
    const original = new ApiRequestError("Controlled failure", status, 2500);
    wire(() => { throw original; });
    const result = await detail(provider, data).catch((error: unknown) => error);
    expect(result).toBe(original);
    expect((result as ApiRequestError).status).toBe(status);
    expect((result as ApiRequestError).retryAfterMs).toBe(2500);
  }
});

test("venue-less intraday boundaries retain their UTC instant through Cloud/API encoding", async () => {
  const data = proof({ exchange: "" }), calls = wire(() => unsupported(data));
  const failure = await detail(new GloomberbCloudProvider(), data).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(HistoryRetentionError);
  const params = calls[0]!.searchParams;
  expect(params.get("exchange")).toBe("");
  expect(params.get("startDate")).toBe(new Date(data.requestedStart).toISOString().replace(".000Z", "Z"));
  expect(Date.parse(params.get("endDate")!)).toBe(data.requestedEnd);
});
