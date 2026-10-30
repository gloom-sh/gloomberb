import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { BitcoinNetworkDailyValue, BitcoinNetworkPayload } from "../../../api-client/crypto-markets";
import { createPluginCache } from "../../../data/plugin-cache";
import type { SeriesAttribution, SeriesDefinition, SeriesPoint } from "../../../series/types";
import { isFiniteNumber } from "../../../utils/guards";
import { loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { cachedSeriesNote } from "../shared/series-warning";

const bitcoinNetworkCache = createPluginCache<BitcoinNetworkPayload>({
  kind: "bitcoin-network",
  source: "gloom-cloud",
  schemaVersion: 1,
  // The server reads the estimate every half hour and the daily figures every six hours.
  policy: { staleMs: 30 * 60_000, expireMs: 30 * 86_400_000 },
});

export const BITCOIN_NETWORK_CACHES = [bitcoinNetworkCache] as const;

const MAX_DAYS = 20_000;
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const daily = (rows: unknown): rows is BitcoinNetworkDailyValue[] => Array.isArray(rows) && rows.length <= MAX_DAYS
  && rows.every((row) => !!row && date((row as BitcoinNetworkDailyValue).date) && isFiniteNumber((row as BitcoinNetworkDailyValue).value));

function validateBitcoinNetwork(data: BitcoinNetworkPayload): BitcoinNetworkPayload {
  const retarget = data?.retarget;
  if (
    !data
    || data.version !== 1
    || !instant(data.generatedAt)
    || !["available", "stale", "unavailable"].includes(data.status)
    || !daily(data.hashrate)
    || !daily(data.hashprice)
    || !daily(data.retargetHistory)
    || !Array.isArray(data.difficulty)
    || !data.difficulty.every((row) => !!row && date(row.date) && isFiniteNumber(row.difficulty) && row.difficulty > 0)
    || (retarget !== null && (!retarget || !isFiniteNumber(retarget.changePercent) || !instant(retarget.estimatedAt) || !instant(retarget.readAt)))
    || !Array.isArray(data.warnings)
  ) {
    throw new Error("The server returned invalid bitcoin network data");
  }
  return data;
}

async function fetchBitcoinNetwork(client: Pick<typeof apiClient, "getCloudBitcoinNetwork"> = apiClient): Promise<BitcoinNetworkPayload> {
  try {
    return validateBitcoinNetwork(await client.getCloudBitcoinNetwork());
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 503) throw unavailableOnServer(error, "Bitcoin network data is temporarily unavailable", [503]);
    throw unavailableOnServer(error, "Bitcoin network data is not available yet.");
  }
}

function loadBitcoinNetwork() {
  return loadCloudResource(bitcoinNetworkCache, "all", () => fetchBitcoinNetwork(), { validate: validateBitcoinNetwork });
}

const points = (rows: readonly BitcoinNetworkDailyValue[]): SeriesPoint[] =>
  rows.map((row) => ({ date: Date.parse(`${row.date}T00:00:00Z`), value: row.value }));

const MEMPOOL: SeriesAttribution = { source: "mempool.space", publisher: "mempool.space" };
const TAGS = ["bitcoin", "BTC", "BTC-USD", "mining", "miner", "miners", "bitcoin mining", "network", "on-chain"];
const SOURCE_URL = "https://mempool.space/mining";

/** A series of the network board: its points, the board's own warning, and the cached-copy note. */
function networkSeries(
  definition: Omit<Extract<SeriesDefinition, { load: unknown }>, "load" | "frequency" | "group" | "url">
    & { frequency?: SeriesDefinition["frequency"] },
  read: (payload: BitcoinNetworkPayload) => SeriesPoint[],
  { attribution = MEMPOOL, part = "history" }: { attribution?: SeriesAttribution; part?: "history" | "retarget" } = {},
): SeriesDefinition {
  return {
    frequency: "daily",
    group: "Crypto",
    url: SOURCE_URL,
    refreshMs: 30 * 60_000,
    ...definition,
    load: async () => {
      const resource = await loadBitcoinNetwork();
      const found = read(resource.payload);
      if (!found.length) throw new Error(`${definition.name} is not available yet.`);
      const note = cachedSeriesNote(resource);
      // The board says which part could not refresh: the daily figures, or the retarget estimate.
      const own = resource.payload.warnings.find((line) => /retarget/i.test(line) === (part === "retarget"));
      const warning = note.warning ?? own;
      return { points: found, attribution, ...note, ...warning ? { warning } : {} };
    },
  } as SeriesDefinition;
}

/**
 * The bitcoin network for `fn G`: hash rate, difficulty, the next
 * retarget's estimate and hashprice. `catalog hashrate`, `hashprice`,
 * `difficulty`, `mining` and `miner` find them by their tags.
 */
export const BITCOIN_NETWORK_SERIES: readonly SeriesDefinition[] = [
  networkSeries({
    id: "bitcoin:hashrate",
    name: "Bitcoin network hash rate",
    unit: "EH/s",
    tags: [...TAGS, "hashrate", "hash rate"],
    description: "The bitcoin network's hash rate in exahashes per second, each UTC day's average as mempool.space estimates it from the blocks found; the newest day is the day so far.",
  }, (payload) => points(payload.hashrate)),
  networkSeries({
    id: "bitcoin:difficulty",
    name: "Bitcoin mining difficulty (trillions)",
    unit: "number",
    frequency: "irregular",
    style: "step",
    tags: [...TAGS, "difficulty", "retarget", "difficulty adjustment"],
    description: "The difficulty each retarget set, every 2,016 blocks, in trillions, dated by the block that set it, as mempool.space lists it.",
  }, (payload) => payload.difficulty.map((row) => ({ date: Date.parse(`${row.date}T00:00:00Z`), value: Number((row.difficulty / 1e12).toFixed(4)) }))),
  networkSeries({
    id: "bitcoin:retarget-estimate",
    name: "Bitcoin next difficulty retarget estimate",
    unit: "%",
    tags: [...TAGS, "difficulty", "retarget", "difficulty adjustment", "estimate"],
    description: "mempool.space's estimate of the change in difficulty at the next retarget, in percent, as read each UTC day since Gloom began keeping it in October 2026.",
  }, (payload) => points(payload.retargetHistory), { part: "retarget" }),
  networkSeries({
    id: "bitcoin:hashprice",
    name: "Bitcoin hashprice (derived)",
    unit: "USD/PH/s/day",
    tags: [...TAGS, "hashprice", "hash price", "miner revenue"],
    description: "Derived, not quoted: what 1 PH/s is expected to earn in a day, in USD, at the day's difficulty, average block reward (subsidy and fees) and BTC price, all from mempool.space.",
  }, (payload) => points(payload.hashprice), {
    attribution: { source: "Derived from mempool.space block rewards, BTC price and difficulty", publisher: "mempool.space" },
  }),
];
