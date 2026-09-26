import { expect, test } from "bun:test";
import { MarketDataCoordinator } from "../../market-data/coordinator";
import { resolveDatedReturns } from "../../plugins/builtin/analytics/metrics";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { PricePoint } from "../../types/financials";
import { AssetDataRouter } from "./index";

const points = (dates: string[], value: number) => dates.map((date, index) => ({ date: new Date(date), close: value + index }));
function record(symbol: string, range: string, value: PricePoint[], source = "cache-test", resolution = "") {
  return { namespace: "market", kind: "price-history", entityKey: symbol,
    variantKey: `exchange=NYSE;range=${range};${resolution ? `resolution=${resolution};` : ""}version=6`,
    sourceKey: `provider:${source}`, value: { points: value, resolution: resolution || null }, schemaVersion: 1, fetchedAt: Date.now(), stale: false, expired: false };
}
function memoryResources(initial: ReturnType<typeof record>[]) {
  let records = initial;
  return {
    list(query: any, options: any) { return records.filter((row) => row.kind === query.kind && row.entityKey === query.entityKey
      && options.variantKeys.includes(row.variantKey) && options.sourceKeys.includes(row.sourceKey)); },
    set(key: any, value: unknown) {
      const row = { ...key, value, schemaVersion: 1, fetchedAt: Date.now(), stale: false, expired: false };
      records = records.filter((old) => old.variantKey !== row.variantKey || old.sourceKey !== row.sourceKey);
      records.push(row); return row;
    },
  };
}

for (const mode of ["exact-cache", "fresh-provider"] as const) test(`broader missing dates stay inside the requested window: ${mode}`, async () => {
  const exact = points(["2026-08-12", "2026-09-10"], 100);
  const gaps = points(["2025-09-10", "2026-08-20", "2026-10-20"], NaN);
  let calls = 0;
  const provider = createTestDataProvider({ id: "cache-test", getPriceHistoryForResolution: async () => { calls++; return exact; } });
  const resources = memoryResources([record("WIN", "1Y", gaps, "cache-test", "1d"),
    ...(mode === "exact-cache" ? [record("WIN", "1M", exact, "cache-test", "1d")] : [])]);
  const coordinator = new MarketDataCoordinator(new AssetDataRouter(provider, [], resources as any));
  try {
    const entry = await coordinator.loadChart({ instrument: { symbol: "WIN", exchange: "NYSE" },
      bufferRange: "1M", granularity: "resolution", resolution: "1d" });
    expect(entry.data!.map((point) => point.date.toISOString().slice(0, 10)))
      .toEqual(["2026-08-12", "2026-08-20", "2026-09-10"]);
    expect(calls).toBe(mode === "exact-cache" ? 0 : 1);
    expect(entry.error).toBeNull();
  } finally { coordinator.destroy(); }
});

for (const mode of ["reported-missing", "transport-error", "independent-cache"] as const) test(`cached chart refresh respects current source declarations: ${mode}`, async () => {
  const good = points(["2026-09-01", "2026-09-02", "2026-09-03"], 100);
  const missing = good.map((point) => ({ ...point, close: NaN }));
  const alternate = good.map((point) => ({ ...point, close: point.close * 2 }));
  let calls = 0;
  const provider = createTestDataProvider({ id: "cache-test", getPriceHistory: async () => {
    calls++; if (mode === "transport-error") throw new Error("Temporary upstream unavailable"); return missing;
  } });
  const secondary = createTestDataProvider({ id: "independent", getPriceHistory: async () => { throw new Error("Temporary upstream unavailable"); } });
  const resources = memoryResources([record("RET", "1Y", good),
    ...(mode === "independent-cache" ? [record("RET", "1Y", alternate, "independent")] : [])]);
  const router = mode === "independent-cache" ? new AssetDataRouter(secondary, [provider], resources as any)
    : new AssetDataRouter(provider, [], resources as any);
  const coordinator = new MarketDataCoordinator(router);
  const request = { instrument: { symbol: "RET", exchange: "NYSE" }, bufferRange: "1Y" as const };
  try {
    expect((await coordinator.loadChart(request)).data?.map((point) => point.close)).toEqual([100, 101, 102]);
    const refresh = await coordinator.loadChart(request, { forceRefresh: true });
    expect(refresh.data?.map((point) => point.close)).toEqual(mode === "reported-missing" ? [NaN, NaN, NaN]
      : mode === "independent-cache" ? [200, 202, 204] : [100, 101, 102]);
    expect(refresh.error?.reasonCode ?? null).toBe(mode === "reported-missing" ? "NO_DATA" : null);
    expect(refresh.attempts[0]?.status).toBe(mode === "reported-missing" ? "empty" : "success");
    expect(resolveDatedReturns(refresh.data!).returns).toHaveLength(mode === "reported-missing" ? 0 : 2);
    expect(calls).toBe(1);
  } finally { coordinator.destroy(); }
});

test("intraday freshness cannot erase an entirely missing dated response", async () => {
  const now = Date.now();
  const missing = [now - 15 * 60_000, now].map((date) => ({ date: new Date(date), close: NaN }));
  const provider = createTestDataProvider({ id: "intraday-missing", getPriceHistoryForResolution: async () => missing });
  const coordinator = new MarketDataCoordinator(new AssetDataRouter(provider, []));
  try {
    const entry = await coordinator.loadChart({ instrument: { symbol: "GAP", exchange: "NYSE" },
      bufferRange: "1D", granularity: "resolution", resolution: "15m" });
    expect(entry.data).toEqual(missing);
    expect(entry.error?.reasonCode).toBe("NO_DATA");
    expect(entry.attempts[0]?.status).toBe("empty");
  } finally { coordinator.destroy(); }
});
