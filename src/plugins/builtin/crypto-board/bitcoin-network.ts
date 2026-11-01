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
    || typeof data.source?.name !== "string" || !data.source.name.trim()
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

const TAGS = ["bitcoin", "BTC", "BTC-USD", "mining", "miner", "miners", "bitcoin mining", "network", "on-chain"];

/**
 * A series of the network board: its points, cited as the server names its
 * source, with the board's warnings about this figure (`concerns`: "Hash
 * rate, difficulty and hashprice could not refresh" is three series', "The
 * retarget estimate is unavailable" the estimate's alone) and the
 * cached-copy note.
 */
function networkSeries(
  definition: Omit<Extract<SeriesDefinition, { load: unknown }>, "load" | "frequency" | "group">
    & { frequency?: SeriesDefinition["frequency"] },
  read: (payload: BitcoinNetworkPayload) => SeriesPoint[],
  { concerns, derived }: { concerns: RegExp; derived?: string },
): SeriesDefinition {
  return {
    frequency: "daily",
    group: "Crypto",
    refreshMs: 30 * 60_000,
    ...definition,
    load: async () => {
      const resource = await loadBitcoinNetwork();
      const found = read(resource.payload);
      if (!found.length) throw new Error(`${definition.name} is not available yet.`);
      const note = cachedSeriesNote(resource);
      const own = resource.payload.warnings.filter((line) => concerns.test(line)).join(" ");
      const warning = note.warning ?? (own || undefined);
      const source = resource.payload.source.name.trim();
      const attribution: SeriesAttribution = { source: derived ? `${source}, ${derived}` : source };
      return { points: found, attribution, ...note, ...warning ? { warning } : {} };
    },
  } as SeriesDefinition;
}

/**
 * The bitcoin network for `fn G`: hash rate, difficulty, the next
 * retarget's estimate and hashprice. `fn G hashrate`, `difficulty`,
 * `retarget` and `hashprice` chart them by their aliases; `catalog
 * hashrate`, `hashprice`, `difficulty`, `mining` and `miner` find them by
 * their tags.
 */
export const BITCOIN_NETWORK_SERIES: readonly SeriesDefinition[] = [
  networkSeries({
    id: "bitcoin:hashrate",
    name: "Bitcoin network hash rate",
    unit: "EH/s",
    tags: [...TAGS, "hashrate", "hash rate"],
    aliases: ["hashrate"],
    description: "The bitcoin network's hash rate in exahashes per second, each UTC day's average, estimated from the blocks found; the newest day is the day so far.",
  }, (payload) => points(payload.hashrate), { concerns: /\bhash rate\b/i }),
  networkSeries({
    id: "bitcoin:difficulty",
    name: "Bitcoin mining difficulty (trillions)",
    unit: "number",
    frequency: "irregular",
    style: "step",
    tags: [...TAGS, "difficulty", "retarget", "difficulty adjustment"],
    aliases: ["difficulty"],
    description: "The difficulty each retarget set, every 2,016 blocks, in trillions, dated by the block that set it.",
  }, (payload) => payload.difficulty.map((row) => ({ date: Date.parse(`${row.date}T00:00:00Z`), value: Number((row.difficulty / 1e12).toFixed(4)) })),
  { concerns: /\bdifficulty\b/i }),
  networkSeries({
    id: "bitcoin:retarget-estimate",
    name: "Bitcoin next difficulty retarget estimate",
    unit: "%",
    tags: [...TAGS, "difficulty", "retarget", "difficulty adjustment", "estimate"],
    aliases: ["retarget"],
    description: "The estimated change in difficulty at the next retarget, in percent, as read each UTC day since Gloom began keeping it in October 2026.",
  }, (payload) => points(payload.retargetHistory), { concerns: /\bretarget\b/i }),
  networkSeries({
    id: "bitcoin:hashprice",
    name: "Bitcoin hashprice (derived)",
    unit: "USD/PH/s/day",
    tags: [...TAGS, "hashprice", "hash price", "miner revenue"],
    aliases: ["hashprice"],
    description: "Derived, not quoted: what 1 PH/s is expected to earn in a day, in USD, at the day's difficulty, average block reward (subsidy and fees) and BTC price.",
  }, (payload) => points(payload.hashprice), {
    concerns: /\bhashprice\b/i,
    derived: "derived from the block rewards, the BTC price and the difficulty",
  }),
];
