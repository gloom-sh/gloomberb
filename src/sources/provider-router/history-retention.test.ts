import { afterEach, expect, spyOn, test } from "bun:test";
import { ApiRequestError } from "../../api-client/errors";
import { AppPersistence } from "../../data/app-persistence";
import type { DataProvider, MarketDataRequestContext } from "../../types/data-provider";
import type { PricePoint } from "../../types/financials";
import { HistoryCoverageError } from "../history-coverage";
import { HistoryRetentionError, parseHistoryRetention, type HistoryRecoveryCandidate, type HistoryRetention } from "../history-retention";
import { ProviderMissError } from "../provider-errors";
import { AssetDataRouter } from "./index";
import { attachTestRegistry, brokerInstance, cleanupProviderRouterTestFiles, createTempDbPath, fallbackProvider, setBrokerInstances } from "./test-support";

afterEach(cleanupProviderRouterTestFiles);
const DAY = 86_400_000;
const proof = (patch: Partial<HistoryRetention> = {}): HistoryRetention => {
  const observedAt = Math.floor(Date.now() / 1000) * 1000;
  return { version: 1, source: "yahoo", symbol: "BTC-USD", exchange: "CCC", interval: "15min",
    requestedStart: observedAt - 90 * DAY, requestedEnd: observedAt, observedAt, availableStart: observedAt - 60 * DAY, ...patch };
};
const points = (): PricePoint[] => [{ date: new Date(Math.floor(Date.now() / 1000) * 1000 - 900_000), close: 100 }];
const history = (router: AssetDataRouter, context?: MarketDataRequestContext) => router.getPriceHistoryForResolution("BTC-USD", "CCC", "3M", "15m", context);
function limited(calls: string[], id = "cloud-test", data = proof()): DataProvider {
  return { ...fallbackProvider, id, priority: 1,
    async getPriceHistoryForResolution() { calls.push(`${id}:broad`); throw new HistoryRetentionError(data); },
    async getDetailedPriceHistory(_ticker, _exchange, start, end, bar, context) {
      calls.push(`${id}:detailed`);
      expect(context?.historyRecovery?.retention.source).toBe("yahoo");
      expect(+start).toBeGreaterThanOrEqual(data.availableStart);
      expect(+end).toBeLessThanOrEqual(data.requestedEnd);
      expect(bar).toBe("15m");
      return points();
    } };
}
async function exhausted(router: AssetDataRouter, context?: MarketDataRequestContext): Promise<HistoryRetentionError> {
  const failure = await history(router, context).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(HistoryRetentionError);
  return failure as HistoryRetentionError;
}
const recover = (router: AssetDataRouter, candidate: HistoryRecoveryCandidate, context: MarketDataRequestContext = {}) => router.getDetailedPriceHistory(
  "BTC-USD", "CCC", new Date(candidate.retention.availableStart), new Date(candidate.retention.requestedEnd), "15m", { ...context, historyRecovery: candidate },
);

test("mixed source exhaustion freezes eligible ownership and replays only the selected provider", async () => {
  const calls: string[] = [], store = new AppPersistence(createTempDbPath("retention-scoped"));
  try {
    const alternatives: DataProvider[] = [401, 429, 503].map((status) => ({ ...fallbackProvider, id: `status-${status}`, priority: 10,
      async getPriceHistoryForResolution() { calls.push(`status-${status}:broad`); throw new ApiRequestError("Controlled source", status, 2000); },
      async getDetailedPriceHistory() { calls.push(`status-${status}:detailed`); return points(); } }));
    const router = new AssetDataRouter(limited(calls), alternatives, store.resources);
    const failure = await exhausted(router);
    expect(failure.candidates.map((candidate) => candidate.sourceKey)).toEqual(["provider:cloud-test"]);
    expect(Object.fromEntries(failure.outcomes.map((outcome) => [outcome.sourceKey, outcome.outcome]))).toEqual({
      "provider:cloud-test": "retention", "provider:status-401": "auth", "provider:status-429": "rate-limit", "provider:status-503": "transient",
    });
    expect(Object.isFrozen(failure.candidates)).toBe(true);
    expect(Object.isFrozen(failure.candidates[0]!.request)).toBe(true);
    expect(Object.isFrozen(failure.outcomes[0])).toBe(true);
    const candidate = failure.candidates[0]!;
    // Ordinary Cloud data at the same bounds does not attest the hidden source.
    store.resources.set({ namespace: "market", kind: "detailed-price-history", entityKey: "BTC-USD", sourceKey: "provider:cloud-test",
      variantKey: `exchange=CCC;start=${new Date(candidate.retention.availableStart).toISOString()};end=${new Date(candidate.retention.requestedEnd).toISOString()};bar=15m;version=5` },
    [{ date: points()[0]!.date, close: 999 }], { cachePolicy: { staleMs: 60_000, expireMs: 600_000 } });
    expect((await recover(router, candidate))[0]!.close).toBe(100);
    expect((await recover(router, candidate))[0]!.close).toBe(100);
    expect(calls.filter((call) => call.endsWith(":detailed"))).toEqual(["cloud-test:detailed"]);
    expect(calls.filter((call) => call.endsWith(":broad"))).toHaveLength(4);
  } finally { store.close(); }
});

test("a pending independent broad success beats an earlier retention failure", async () => {
  const calls: string[] = [];
  let release!: (value: PricePoint[]) => void;
  const pending = new Promise<PricePoint[]>((resolve) => { release = resolve; });
  const router = new AssetDataRouter({ ...fallbackProvider, id: "independent", priority: 10,
    async getPriceHistoryForResolution() { calls.push("independent:broad"); return pending; } }, [limited(calls)]);
  let settled = false;
  const result = history(router).finally(() => { settled = true; });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  release(points());
  expect((await result)[0]!.close).toBe(100);
  expect(calls).toEqual(["cloud-test:broad", "independent:broad"]);
});

test("an already returned broad success stays successful when a slower retention source settles", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const data = proof();
  const slow = { ...limited(calls), async getPriceHistoryForResolution() { calls.push("slow:broad"); await gate; throw new HistoryRetentionError(data); } };
  const router = new AssetDataRouter({ ...fallbackProvider, id: "independent", priority: 10, async getPriceHistoryForResolution() { return points(); } }, [slow]);
  try {
    // The existing 200ms speculative-provider policy remains active.
    const result = await history(router);
    const snapshot = JSON.stringify(result);
    release(); await Bun.sleep(0);
    expect(JSON.stringify(result)).toBe(snapshot);
    expect(result[0]!.close).toBe(100);
    expect(calls).toEqual(["slow:broad"]);
  } finally { release(); }
});

test("fresh broad cache fallback, reported gaps and coverage restrictions precede recovery", async () => {
  const store = new AppPersistence(createTempDbPath("retention-precedence")), calls: string[] = [];
  try {
    store.resources.set({ namespace: "market", kind: "price-history", entityKey: "BTC-USD", variantKey: "exchange=CCC;range=3M;resolution=15m;version=5", sourceKey: "provider:cloud-test" },
      points(), { cachePolicy: { staleMs: 60_000, expireMs: 600_000 } });
    expect((await history(new AssetDataRouter(limited(calls), [], store.resources), { cacheMode: "refresh" }))[0]!.close).toBe(100);
    const gaps = [{ date: points()[0]!.date, close: null }] as PricePoint[];
    expect(await history(new AssetDataRouter(limited(calls), [{ ...fallbackProvider, id: "gaps", async getPriceHistoryForResolution() { return gaps; } }]))).toEqual(gaps);
    await expect(history(new AssetDataRouter(limited(calls), [{ ...fallbackProvider, id: "coverage", async getPriceHistoryForResolution() { throw new HistoryCoverageError(); } }]))).rejects.toBeInstanceOf(HistoryCoverageError);
    expect(calls.some((call) => call.endsWith(":detailed"))).toBe(false);
  } finally { store.close(); }
});

test("stale, empty, absent and malformed sources do not become retention candidates", async () => {
  const calls: string[] = [];
  const alternatives: DataProvider[] = [
    { ...fallbackProvider, id: "empty", async getPriceHistoryForResolution() { return []; } },
    { ...fallbackProvider, id: "absent" },
    { ...fallbackProvider, id: "stale", async getPriceHistoryForResolution() { return [{ date: new Date(Date.now() - 2 * DAY), close: 10 }]; } },
    { ...fallbackProvider, id: "malformed", async getPriceHistoryForResolution() { return {} as PricePoint[]; } },
    { ...fallbackProvider, id: "message-only", async getPriceHistoryForResolution() { throw new ProviderMissError("The requested range must be within the last 60 days"); } },
  ];
  const failure = await exhausted(new AssetDataRouter(limited(calls), alternatives));
  expect(failure.candidates).toHaveLength(1);
  expect(Object.fromEntries(failure.outcomes.map((outcome) => [outcome.sourceKey, outcome.outcome]))).toMatchObject({
    "provider:empty": "empty", "provider:absent": "missing-method", "provider:stale": "stale", "provider:malformed": "malformed", "provider:message-only": "failure",
  });
});

test("source metadata must match the target, interval and exact detailed original bounds", async () => {
  for (const patch of [{ symbol: "OTHER" }, { exchange: "NASDAQ" }, { interval: "1h" }]) {
    const calls: string[] = [], router = new AssetDataRouter(limited(calls, "cloud-test", proof(patch)));
    const failure = await history(router).catch((error) => error);
    expect(failure).not.toBeInstanceOf(HistoryRetentionError);
  }
  const data = proof(), calls: string[] = [];
  const router = new AssetDataRouter({ ...limited(calls), async getDetailedPriceHistory() { throw new HistoryRetentionError(data); } });
  const failure = await router.getDetailedPriceHistory("BTC-USD", "CCC", new Date(data.requestedStart + 1000), new Date(data.requestedEnd), "15m").catch((error) => error);
  expect(failure).not.toBeInstanceOf(HistoryRetentionError);
  expect(await router.getDetailedPriceHistory("BTC-USD", "CCC", new Date(data.requestedStart + 1000), new Date(data.requestedEnd), "15m")).toEqual([]);
});

test("recovery rejects altered target, interval, contract, source and expanding or expired bounds without calls", async () => {
  const calls: string[] = [], router = new AssetDataRouter(limited(calls));
  const candidate = (await exhausted(router)).candidates[0]!;
  const { availableStart, requestedEnd } = candidate.retention;
  const attempts: Array<() => Promise<unknown>> = [
    () => router.getDetailedPriceHistory("OTHER", "CCC", new Date(availableStart), new Date(requestedEnd), "15m", { historyRecovery: candidate }),
    () => router.getDetailedPriceHistory("BTC-USD", "NASDAQ", new Date(availableStart), new Date(requestedEnd), "15m", { historyRecovery: candidate }),
    () => router.getDetailedPriceHistory("BTC-USD", "CCC", new Date(availableStart), new Date(requestedEnd), "1h", { historyRecovery: candidate }),
    () => router.getDetailedPriceHistory("BTC-USD", "CCC", new Date(availableStart - 1), new Date(requestedEnd), "15m", { historyRecovery: candidate }),
    () => router.getDetailedPriceHistory("BTC-USD", "CCC", new Date(availableStart), new Date(requestedEnd + 1), "15m", { historyRecovery: candidate }),
    () => recover(router, { ...candidate, sourceKey: "provider:removed" }),
    () => recover(router, candidate, { instrument: { brokerId: "ibkr", symbol: "BTC", conId: 12 } }),
    () => history(router, { historyRecovery: candidate }),
    () => recover(new AssetDataRouter(null), candidate),
  ];
  for (const attempt of attempts) await expect(attempt()).rejects.toThrow();
  const clock = spyOn(Date, "now").mockReturnValue(candidate.retention.observedAt + 300_001);
  try { await expect(recover(router, candidate)).rejects.toThrow(); } finally { clock.mockRestore(); }
  expect(calls).toEqual(["cloud-test:broad"]);
});

test("broker timeout is frozen as an outcome and a scoped provider retry never replays it", async () => {
  const originalTimer = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) =>
    originalTimer(handler, delay === 10_000 ? 0 : delay, ...args)) as typeof setTimeout);
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const router = new AssetDataRouter(limited(calls));
  attachTestRegistry(router, { brokers: [["ibkr", { id: "ibkr", name: "Controlled", configSchema: [], validate: async () => true, importPositions: async () => [],
    async getPriceHistoryForResolution() { calls.push("broker:broad"); await gate; return []; },
    async getDetailedPriceHistory() { calls.push("broker:detailed"); return points(); },
  }]] });
  setBrokerInstances(router, [brokerInstance()]);
  const context = { brokerId: "ibkr", brokerInstanceId: "ibkr-work", instrument: { brokerId: "ibkr", brokerInstanceId: "ibkr-work", symbol: "BTC", conId: 11 } };
  try {
    const failure = await exhausted(router, context), snapshot = JSON.stringify(failure.outcomes);
    expect(failure.outcomes).toContainEqual({ sourceKey: "broker:ibkr:ibkr-work", outcome: "timeout" });
    expect((await recover(router, failure.candidates[0]!, context))[0]!.close).toBe(100);
    release(); await Bun.sleep(0);
    expect(JSON.stringify(failure.outcomes)).toBe(snapshot);
    expect(calls).toEqual(["broker:broad", "cloud-test:broad", "cloud-test:detailed"]);
  } finally { release(); await Bun.sleep(0); timer.mockRestore(); }
});

test("broad broker success and coverage precede recovery without inventing broker eligibility", async () => {
  for (const outcome of ["success", "coverage", "retention"]) {
    const calls: string[] = [], router = new AssetDataRouter(limited(calls));
    attachTestRegistry(router, { brokers: [["ibkr", { id: "ibkr", name: "Controlled", configSchema: [], validate: async () => true, importPositions: async () => [],
      async getPriceHistoryForResolution() {
        calls.push("broker:broad");
        if (outcome === "coverage") throw new HistoryCoverageError();
        if (outcome === "retention") throw new HistoryRetentionError(proof());
        return points();
      },
    }]] });
    setBrokerInstances(router, [brokerInstance()]);
    const context = { brokerId: "ibkr", brokerInstanceId: "ibkr-work" };
    if (outcome === "success") {
      expect((await history(router, context))[0]!.close).toBe(100);
      expect(calls).toEqual(["broker:broad"]);
    } else if (outcome === "coverage") {
      await expect(history(router, context)).rejects.toBeInstanceOf(HistoryCoverageError);
    } else {
      const failure = await exhausted(router, context);
      expect(failure.candidates.map((candidate) => candidate.sourceKey)).toEqual(["provider:cloud-test"]);
      expect(failure.outcomes).toContainEqual({ sourceKey: "broker:ibkr:ibkr-work", outcome: "retention" });
    }
  }
});

test("canonical unqualified retention is accepted without adding a venue", async () => {
  const data = proof({ exchange: "" });
  expect(parseHistoryRetention(data)?.exchange).toBe("");
  const calls: string[] = [], router = new AssetDataRouter(limited(calls, "cloud-test", data));
  const failure = await router.getPriceHistoryForResolution("BTC-USD", "", "3M", "15m").catch((error) => error);
  expect(failure).toBeInstanceOf(HistoryRetentionError);
  expect(failure.candidates[0].request.exchange).toBe("");
});

test("fully old windows retain typed exhaustion without a recoverable subset, and future ends stay source-owned", async () => {
  const current = proof();
  const old = proof({ requestedEnd: current.availableStart - DAY });
  expect(parseHistoryRetention(old)).not.toBeNull();
  const failure = await exhausted(new AssetDataRouter(limited([], "cloud-test", old)));
  expect(failure.retention).toEqual(old);
  expect(failure.candidates).toEqual([]);
  expect(parseHistoryRetention(proof({ requestedEnd: current.observedAt + DAY }))?.requestedEnd).toBe(current.observedAt + DAY);
});

test("optional resolution discovery keeps its existing fallback behavior", async () => {
  const calls: string[] = [];
  const router = new AssetDataRouter({ ...limited(calls), getChartResolutionSupport() { throw new HistoryRetentionError(proof()); } },
    [{ ...fallbackProvider, id: "independent", getChartResolutionSupport() { return [{ resolution: "1d", maxRange: "5Y" }]; } }]);
  expect(await router.getChartResolutionSupport("BTC-USD", "CCC")).toEqual([{ resolution: "1d", maxRange: "5Y" }]);
});
