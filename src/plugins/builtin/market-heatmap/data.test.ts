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
