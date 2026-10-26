import { describe, expect, test } from "bun:test";
import { isProviderBusy, ProviderBusyError } from "../../../../sources/provider-errors";
import { searchWithinDeadline } from "./provider-search";

describe("searchWithinDeadline", () => {
  test("a search that never answers ends as a busy service", async () => {
    const started = Date.now();
    const error = await searchWithinDeadline(new Promise<never>(() => {}), 20).catch((caught: unknown) => caught);

    expect(isProviderBusy(error)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("passes an answer and any other failure through", async () => {
    expect(await searchWithinDeadline(Promise.resolve(["MSFT"]), 1_000)).toEqual(["MSFT"]);

    const busy = new ProviderBusyError("Cloud search is busy");
    expect(await searchWithinDeadline(Promise.reject(busy), 1_000).catch((caught: unknown) => caught)).toBe(busy);
    const failure = new Error("offline");
    expect(await searchWithinDeadline(Promise.reject(failure), 1_000).catch((caught: unknown) => caught)).toBe(failure);
  });
});
