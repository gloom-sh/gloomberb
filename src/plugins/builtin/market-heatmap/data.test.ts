import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { dedupeHeatmapAssets, fetchMarketHeatmap, resetMarketHeatmapCache } from "./data";
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; resetMarketHeatmapCache(); });
test("concurrent requests share the backend snapshot and force refresh replaces the cache", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof apiClient.getMarketHeatmap>>>();
  const api = spyOn(apiClient, "getMarketHeatmap").mockReturnValue(pending.promise);
  restore = () => api.mockRestore();
  const first = fetchMarketHeatmap("us-etf");
  const second = fetchMarketHeatmap("us-etf");
  pending.resolve({ status: "success", data: { universe: "us-etf", source: "gloom", fetchedAt: 123, assets: [] } });
  expect(await first).toEqual(await second);
  await fetchMarketHeatmap("us-etf");
  expect(api).toHaveBeenCalledTimes(1);
  await fetchMarketHeatmap("us-etf", { forceRefresh: true });
  expect(api).toHaveBeenCalledTimes(2);
});
test("backend failures do not cache an empty success and later requests recover", async () => {
  const api = spyOn(apiClient, "getMarketHeatmap").mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue({ status: "success", data: { universe: "us-equity", source: "gloom", fetchedAt: 123, assets: [] } });
  restore = () => api.mockRestore();
  await expect(fetchMarketHeatmap("us-equity")).rejects.toThrow("Unavailable");
  expect((await fetchMarketHeatmap("us-equity")).fetchedAt).toBe(123);
  expect(api).toHaveBeenCalledTimes(2);
});

for (const staleLocation of ["envelope", "data"] as const) test(`retained ${staleLocation} status preserves the heatmap timestamp and rows`, async () => {
  const asset = { symbol: "ACME", price: 100 } as any;
  const response = { status: "partial" as const, stale: staleLocation === "envelope",
    data: { universe: "us-equity" as const, source: "gloom" as const, fetchedAt: 123, stale: staleLocation === "data", assets: [asset] } };
  const result = await fetchMarketHeatmap("us-equity", { cache: false }, { client: { getMarketHeatmap: async () => response } });
  expect(result).toMatchObject({ stale: true, fetchedAt: 123, assets: [asset] });
});

test("mismatched universes and failed envelopes never become a usable cached board", async () => {
  for (const response of [
    { status: "success", data: { universe: "us-etf", assets: [] } },
    { status: "retryable_error", data: { universe: "us-equity", assets: [] } },
  ]) {
    await expect(fetchMarketHeatmap("us-equity", { cache: false }, { client: { getMarketHeatmap: async () => response as any } }))
      .rejects.toThrow("Market heatmap unavailable");
  }
});

test("a board asks for at most 500 names, and an older server's shorter answer is used as is", async () => {
  const counts: number[] = [];
  const client = { getMarketHeatmap: async (_universe: string, count: number) => {
    counts.push(count);
    return { status: "success" as const, data: { universe: "us-equity" as const, source: "gloom" as const, fetchedAt: 1,
      assets: Array.from({ length: Math.min(count, 160) }, (_, index) => ({ symbol: `S${index}` }) as any) } };
  } };
  const result = await fetchMarketHeatmap("us-equity", { count: 900, cache: false }, { client: client as any });
  expect(counts).toEqual([500]);
  expect(result.assets).toHaveLength(160);
});

test("a board records when its check succeeded, apart from the snapshot's own time, and how many listings it covers", async () => {
  const listing = (symbol: string, exchange: string) => ({ symbol, exchange, size: 1 }) as any;
  const api = spyOn(apiClient, "getMarketHeatmap").mockResolvedValue({ status: "success", data: { universe: "us-equity", source: "gloom",
    fetchedAt: 123, assets: [listing("AAA", "NASDAQ"), listing("KHC", "NASDAQ"), listing("KHC", "NYSE")] } });
  restore = () => api.mockRestore();
  const before = Date.now();
  const board = await fetchMarketHeatmap("us-equity", { count: 100 });
  expect(board).toMatchObject({ fetchedAt: 123, topCount: 3 });
  expect(board.assets).toHaveLength(2);
  expect(board.checkedAt).toBeGreaterThanOrEqual(before);
  // A board from the cache is the same check, not a new one.
  expect((await fetchMarketHeatmap("us-equity", { count: 100 })).checkedAt).toBe(board.checkedAt);
  expect((await fetchMarketHeatmap("us-equity", { count: 2 })).topCount).toBe(2);
  expect(api).toHaveBeenCalledTimes(2);
});

test("a company listed twice gets one tile, the larger listing, in its place", () => {
  const assets = [
    { symbol: "AAA", exchange: "NASDAQ", size: 300 },
    { symbol: "KHC", exchange: "NASDAQ", size: 26.68 },
    { symbol: "BBB", exchange: "NYSE", size: 20 },
    { symbol: "KHC", exchange: "NYSE", size: 26.66 },
  ];
  expect(dedupeHeatmapAssets(assets)).toEqual([assets[0]!, assets[1]!, assets[2]!]);
  expect(dedupeHeatmapAssets([assets[3]!, assets[1]!]).map((asset) => asset.exchange)).toEqual(["NASDAQ"]);
});
