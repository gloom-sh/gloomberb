import type { SeriesDefinition } from "../../../series/types";
import { fetchPerpSelection, fetchPerpsCompare, fetchPerpsHistory } from "./client";
import { historyRows, type HistoryMetric } from "./model";

/** The coin a pair names: BTC-USD charts the BTC perpetual. */
function baseAsset(ticker: string): string {
  return ticker.trim().toUpperCase().split(/[-/]/)[0] ?? ticker;
}

/** What the perps pane says where the free preview leaves history out. */
const PRO_HISTORY = "Full history requires Gloom Pro.";

const METRICS: ReadonlyArray<{ metric: HistoryMetric; name: string; unit: string; scale: number; tags: readonly string[] }> = [
  { metric: "funding", name: "Perpetual funding rate (8h)", unit: "%", scale: 100, tags: ["funding", "carry"] },
  { metric: "oi", name: "Perpetual open interest", unit: "USD", scale: 1, tags: ["open interest", "OI", "leverage"] },
  { metric: "premium", name: "Perpetual premium to index", unit: "%", scale: 100, tags: ["premium", "basis"] },
];

const historyStart = (start: Date | undefined) => (start ?? new Date(Date.now() - 90 * 86_400_000)).toISOString();

/**
 * A coin's main perpetual contract, as the perps pane picks it, by the
 * history its detail charts: funding, open interest and premium.
 */
const METRIC_SERIES: readonly SeriesDefinition[] = METRICS.map(({ metric, name, unit, scale, tags }): SeriesDefinition => ({
  id: `perps:${metric}`,
  name,
  unit,
  frequency: "intraday",
  group: "Crypto",
  tags: ["perpetual", "perps", ...tags],
  input: "crypto",
  load: async ({ ticker, start }) => {
    const market = await fetchPerpSelection(baseAsset(ticker!));
    const marketId = market.rows[0]?.marketId;
    if (!marketId) throw new Error(`No perpetual contract for ${baseAsset(ticker!)}.`);
    const history = await fetchPerpsHistory({
      marketId,
      from: historyStart(start),
      resolution: "auto",
      limit: 5000,
    });
    if (history.locked) throw new Error(PRO_HISTORY);
    return historyRows(history, metric).map((row) => ({ date: row.time, value: row.value == null ? null : row.value * scale }));
  },
}));

/**
 * The share of accounts long a coin's perpetual, as the perps pane charts it
 * for a contract whose venue publishes one. Venues count accounts their own
 * way and only some publish a ratio, so the series reads the coin's largest
 * contract that does. History is Pro's.
 */
const LONG_SHORT_SERIES: SeriesDefinition = {
  id: "perps:long-accounts",
  name: "Perpetual long account share",
  unit: "%",
  frequency: "intraday",
  group: "Crypto",
  tags: ["perpetual", "perps", "long/short", "long short ratio", "accounts", "positioning"],
  description: "Share of accounts long the coin's largest perpetual contract whose venue publishes a long/short account ratio, hour by hour, as PERP charts it. Needs Pro.",
  input: "crypto",
  load: async ({ ticker, start }) => {
    const base = baseAsset(ticker!);
    const contracts = await fetchPerpsCompare(base);
    if (contracts.access === "preview") throw new Error(PRO_HISTORY);
    // The server lists a coin's contracts by open interest, largest first.
    const market = contracts.rows.find((row) => !row.delisted && row.longShortRatio);
    if (!market) throw new Error(`No ${base} perpetual contract publishes a long/short account ratio.`);
    const history = await fetchPerpsHistory({ marketId: market.marketId, from: historyStart(start), resolution: "auto", limit: 5000 });
    if (history.locked) throw new Error(PRO_HISTORY);
    return historyRows(history, "long-short").map((row) => ({ date: row.time, value: row.value == null ? null : row.value * 100 }));
  },
};

export const PERP_SERIES: readonly SeriesDefinition[] = [...METRIC_SERIES, LONG_SHORT_SERIES];
