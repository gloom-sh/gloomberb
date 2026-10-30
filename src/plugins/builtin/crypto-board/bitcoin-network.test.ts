import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { BitcoinNetworkPayload } from "../../../api-client/crypto-markets";
import type { SeriesLoadResult } from "../../../series/types";
import { BITCOIN_NETWORK_CACHES, BITCOIN_NETWORK_SERIES } from "./bitcoin-network";

const load = (id: string) => BITCOIN_NETWORK_SERIES.find((entry) => entry.id === id)!.load!({}) as Promise<SeriesLoadResult>;
const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const cache of BITCOIN_NETWORK_CACHES) cache.reset();
});

const board = (patch: Partial<BitcoinNetworkPayload> = {}): BitcoinNetworkPayload => ({
  version: 1,
  generatedAt: "2026-10-30T19:56:00.000Z",
  status: "stale",
  source: { publisher: "mempool.space", url: "https://mempool.space/mining" },
  historyFetchedAt: "2026-10-30T19:55:00.000Z",
  hashrate: [{ date: "2026-10-29", value: 951.2 }, { date: "2026-10-30", value: 964.26 }],
  difficulty: [
    { date: "2026-10-15", height: 971712, difficulty: 140_574_000_000_000, changePercent: 2.1 },
    { date: "2026-10-29", height: 973728, difficulty: 148_364_561_003_867.4, changePercent: 5.54 },
  ],
  hashprice: [{ date: "2026-10-30", value: 33.2713 }],
  retarget: null,
  retargetHistory: [{ date: "2026-10-29", value: -3.9 }, { date: "2026-10-30", value: -4.22 }],
  warnings: ["The retarget estimate is unavailable."],
  ...patch,
});

test("the board charts in its units, and only the part that failed carries the board's warning", async () => {
  spies.push(spyOn(apiClient, "getCloudBitcoinNetwork").mockImplementation(async () => board()));
  const hashrate = await load("bitcoin:hashrate");
  expect(hashrate.points).toEqual([{ date: day("2026-10-29"), value: 951.2 }, { date: day("2026-10-30"), value: 964.26 }]);
  expect(hashrate.warning).toBeUndefined();
  expect((await load("bitcoin:difficulty")).points).toEqual([
    { date: day("2026-10-15"), value: 140.574 },
    { date: day("2026-10-29"), value: 148.3646 },
  ]);
  const retarget = await load("bitcoin:retarget-estimate");
  expect(retarget.points.at(-1)).toEqual({ date: day("2026-10-30"), value: -4.22 });
  expect(retarget.warning).toBe("The retarget estimate is unavailable.");
  expect((await load("bitcoin:hashprice")).attribution?.source).toBe("Derived from mempool.space block rewards, BTC price and difficulty");
});

test("a server without the board says the data is not there yet, and a malformed board is refused", async () => {
  spies.push(spyOn(apiClient, "getCloudBitcoinNetwork").mockImplementation(async () => {
    throw new ApiRequestError("Not found", 404);
  }));
  await expect(load("bitcoin:hashrate")).rejects.toThrow("Bitcoin network data is not available yet.");
  for (const cache of BITCOIN_NETWORK_CACHES) cache.reset();
  spies.splice(0).forEach((spy) => spy.mockRestore());
  spies.push(spyOn(apiClient, "getCloudBitcoinNetwork").mockImplementation(async () => board({ hashrate: [{ date: "30 Oct", value: 1 }] })));
  await expect(load("bitcoin:hashrate")).rejects.toThrow("The server returned invalid bitcoin network data");
});
