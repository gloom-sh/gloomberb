import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { fetchMarketHeatmap, resetMarketHeatmapCache } from "./data";
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
