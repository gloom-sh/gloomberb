import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { findCatalogSeries, renderSeriesMatches } from "../../../cli/series-search";
import { commandPointer, knownGapMessage, topicPointer } from "../../../cli/known-gaps";
import type { SeriesLoadResult } from "../../../series/types";
import { getLoadablePlugins } from "../../catalog";
import { BITCOIN_NETWORK_CACHES, BITCOIN_NETWORK_SERIES } from "./bitcoin-network";
import { bitcoinNetworkFixture } from "./test-fixture";

const load = (id: string) => BITCOIN_NETWORK_SERIES.find((entry) => entry.id === id)!.load!({}) as Promise<SeriesLoadResult>;
const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
const spies: Array<{ mockRestore(): void }> = [];
const serve = (board: ReturnType<typeof bitcoinNetworkFixture>) => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const cache of BITCOIN_NETWORK_CACHES) cache.reset();
  spies.push(spyOn(apiClient, "getCloudBitcoinNetwork").mockImplementation(async () => board));
};
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const cache of BITCOIN_NETWORK_CACHES) cache.reset();
});

test("the board charts in its units, cited as the server names its source", async () => {
  serve(bitcoinNetworkFixture());
  const hashrate = await load("bitcoin:hashrate");
  expect(hashrate.points).toEqual([{ date: day("2026-10-29"), value: 951.2 }, { date: day("2026-10-30"), value: 964.26 }]);
  expect(hashrate.attribution).toEqual({ source: "Gloom Cloud" });
  expect((await load("bitcoin:difficulty")).points).toEqual([
    { date: day("2026-10-15"), value: 140.574 },
    { date: day("2026-10-29"), value: 148.3646 },
  ]);
  expect((await load("bitcoin:retarget-estimate")).points.at(-1)).toEqual({ date: day("2026-10-30"), value: -4.22 });
  expect((await load("bitcoin:hashprice")).attribution)
    .toEqual({ source: "Gloom Cloud, derived from the block rewards, the BTC price and the difficulty" });
});

test("a board warning goes on the charts of the figures it names, and no other", async () => {
  const history = "Hash rate, difficulty and hashprice could not refresh; showing 2026-10-28.";
  const estimate = "The retarget estimate could not refresh; showing the one read 2026-10-30 08:00 UTC.";
  const warnings = async () => Object.fromEntries(await Promise.all(BITCOIN_NETWORK_SERIES.map(async (series) => [series.id, (await load(series.id)).warning])));
  serve(bitcoinNetworkFixture({ warnings: [history] }));
  expect(await warnings()).toEqual({
    "bitcoin:hashrate": history, "bitcoin:difficulty": history, "bitcoin:retarget-estimate": undefined, "bitcoin:hashprice": history,
  });
  serve(bitcoinNetworkFixture({ warnings: [estimate] }));
  expect(await warnings()).toEqual({
    "bitcoin:hashrate": undefined, "bitcoin:difficulty": undefined, "bitcoin:retarget-estimate": estimate, "bitcoin:hashprice": undefined,
  });
});

test("no data vendor is named by the series, their charts or the catalog: Gloom Cloud serves them", async () => {
  // Any web address or site name; the series cite Gloom Cloud by name.
  const vendor = /https?:\/\/|\b[a-z0-9-]+\.(?:space|com|io|org|net|info|xyz)\b/i;
  serve(bitcoinNetworkFixture());
  for (const series of BITCOIN_NETWORK_SERIES) {
    const { load: _load, ...text } = series as typeof series & { load?: unknown };
    expect(JSON.stringify(text), series.id).not.toMatch(vendor);
    const { points: _points, ...loaded } = await load(series.id);
    expect(JSON.stringify(loaded), series.id).not.toMatch(vendor);
  }
  const plugins = getLoadablePlugins();
  for (const query of ["hashrate", "hashprice", "difficulty", "retarget", "mining", "miner", "bitcoin"]) {
    const matches = findCatalogSeries(plugins, query);
    expect(JSON.stringify(matches), query).not.toMatch(vendor);
    expect(renderSeriesMatches(query, matches, 50, 120), query).not.toMatch(vendor);
    const pointers = [commandPointer(query), knownGapMessage(query), topicPointer(query)?.message];
    expect(pointers.join("\n"), query).not.toMatch(vendor);
  }
  expect(findCatalogSeries(plugins, "hashrate").map((match) => match.id)).toContain("bitcoin:hashrate");
  expect(commandPointer("hashrate")).toContain("gloom fn G hashrate");
});

test("a server without the board says the data is not there yet, and a malformed board is refused", async () => {
  spies.push(spyOn(apiClient, "getCloudBitcoinNetwork").mockImplementation(async () => {
    throw new ApiRequestError("Not found", 404);
  }));
  await expect(load("bitcoin:hashrate")).rejects.toThrow("Bitcoin network data is not available yet.");
  serve(bitcoinNetworkFixture({ hashrate: [{ date: "30 Oct", value: 1 }] }));
  await expect(load("bitcoin:hashrate")).rejects.toThrow("The server returned invalid bitcoin network data");
  serve(bitcoinNetworkFixture({ source: undefined as never }));
  await expect(load("bitcoin:hashrate")).rejects.toThrow("The server returned invalid bitcoin network data");
});
