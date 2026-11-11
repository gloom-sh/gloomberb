import { afterEach, expect, setSystemTime, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { DataServiceUnreachableError } from "../../../utils/network-failure";
import { dvolCache, loadDvol, type DvolPayload } from "./dvol";

afterEach(() => {
  setSystemTime();
  dvolCache.reset();
});

const payload: DvolPayload = {
  version: 1, currency: "BTC", observations: [{ date: "2026-11-10", value: 39.45 }],
  latest: { value: 39.79, at: "2026-11-11T15:16:00Z" }, delayed: false, venue: "Deribit",
};

test("a coin's DVOL answers offline from the copy it saved, dated by when; a refusal is not covered by it", async () => {
  let failure: unknown = null;
  const api = { impliedVolatility: async () => { if (failure) throw failure; return payload; } } as never;
  const saved = Date.parse("2026-11-11T15:32:00Z");
  setSystemTime(new Date(saved));
  expect((await loadDvol("BTC", {}, api)).savedAt).toBeUndefined();

  // Every load asks the service first: the copy stands in only when it cannot be reached, or answers 429 or 5xx.
  setSystemTime(new Date(saved + 10 * 60_000));
  failure = new DataServiceUnreachableError(new Error("Unable to connect. Is the computer able to access the url?"));
  expect(await loadDvol("BTC", {}, api)).toMatchObject({ payload, savedAt: saved });
  failure = new ApiRequestError("Too many requests", 429);
  expect(await loadDvol("BTC", {}, api)).toMatchObject({ payload, savedAt: saved });
  failure = new ApiRequestError("Not found", 404);
  await expect(loadDvol("BTC", {}, api)).rejects.toThrow("Not found");
});
