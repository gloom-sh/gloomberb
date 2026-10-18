import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { SeriesLoadResult } from "../../../series/types";
import { STABLECOIN_SUPPLY_CACHES } from "./client";
import { CRYPTO_SERIES } from "./series";
import { stablecoinSupplyFixture } from "./test-fixture";

const series = (id: string) => CRYPTO_SERIES.find((entry) => entry.id === id)!;
const load = (id: string, ticker?: string) => series(id).load!({ ticker }) as Promise<SeriesLoadResult>;
const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const cache of STABLECOIN_SUPPLY_CACHES) cache.reset();
});

test("total supply charts the board's daily totals, a missing day left a gap", async () => {
  spies.push(spyOn(apiClient, "getCloudStablecoinSupply").mockImplementation(async () => stablecoinSupplyFixture()));
  const { points, warning } = await load("crypto:stablecoin-supply");
  expect(points).toEqual([
    { date: day("2026-09-19"), value: 296e9 },
    { date: day("2026-09-20"), value: 297e9 },
    { date: day("2026-09-21"), value: null },
    { date: day("2026-09-22"), value: 299e9 },
    { date: day("2026-09-23"), value: 300e9 },
  ]);
  expect(warning).toBeUndefined();
});

test("a coin's supply reads the coin a pair names, and an unlisted coin says it has no series", async () => {
  const asked: string[] = [];
  spies.push(spyOn(apiClient, "getCloudStablecoinSupplyHistory").mockImplementation(async (symbol) => {
    asked.push(symbol);
    if (symbol !== "USDT") throw new ApiRequestError("Not found", 404);
    const board = stablecoinSupplyFixture();
    return {
      version: 1, generatedAt: board.generatedAt, fetchedAt: board.fetchedAt, asOf: board.asOf, status: "available",
      source: board.source, symbol: "USDT", name: "Tether", pegType: "peggedUSD",
      history: { start: "2026-09-22", values: [179.5e9, 180e9] }, warnings: [],
    };
  }));
  const { points } = await load("crypto:stablecoin-coin-supply", "usdt-usd");
  expect(points).toEqual([{ date: day("2026-09-22"), value: 179.5e9 }, { date: day("2026-09-23"), value: 180e9 }]);
  await expect(load("crypto:stablecoin-coin-supply", "NOPE-USD"))
    .rejects.toThrow("No stablecoin supply series for NOPE: it is not among the stablecoins CRYP lists.");
  expect(asked).toEqual(["USDT", "NOPE"]);
});
