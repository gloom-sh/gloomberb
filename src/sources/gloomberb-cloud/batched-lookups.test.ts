import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import type { InstrumentSearchResult } from "../../types/instrument";
import { cloudSearchBatch, resetCloudBatchSupport } from "./batched-lookups";

afterEach(() => resetCloudBatchSupport());

test("a list's searches go out a hundred to a request, a failed request leaves its queries to be asked alone, and a service without the route is asked no more", async () => {
  const row = (query: string): InstrumentSearchResult => ({ providerId: "gloomberb-cloud", symbol: query, name: query, exchange: "NYSE" });
  const queries = Array.from({ length: 201 }, (_, index) => `S${index}`);
  const asked: number[] = [];
  const search = spyOn(apiClient, "searchInstrumentsBatch").mockImplementation(async (chunk) => {
    asked.push(chunk.length);
    // The second hundred is refused; the others are answered.
    if (chunk[0] === "S100") throw new ApiRequestError("Anonymous market rate limit exceeded", 429);
    return new Map(chunk.map((query) => [query, [row(query)]]));
  });
  try {
    // The service runs at most a hundred queries at once.
    const answers = await cloudSearchBatch(queries, { limit: 30 });
    expect(asked).toEqual([100, 100, 1]);
    expect(answers?.size).toBe(101);
    expect(answers?.has("S99")).toBe(true);
    expect(answers?.has("S100")).toBe(false);
    expect(answers?.get("S200")).toEqual([row("S200")]);

    // The service as deployed before the route (404, or 405 where another method serves the path): no answers,
    // so every symbol is looked up alone, and it is not asked again, however long the list.
    for (const status of [404, 405]) {
      resetCloudBatchSupport();
      search.mockImplementation(async (chunk) => {
        asked.push(chunk.length);
        throw new ApiRequestError("Not Found", status);
      });
      asked.length = 0;
      expect(await cloudSearchBatch(queries)).toBeNull();
      expect(await cloudSearchBatch(queries.slice(0, 5))).toBeNull();
      expect(asked.length).toBeLessThanOrEqual(3);
    }
  } finally {
    search.mockRestore();
  }
});
