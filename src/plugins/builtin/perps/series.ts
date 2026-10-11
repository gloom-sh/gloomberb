import type { SeriesDefinition } from "../../../series/types";
import { fetchPerpSelection, fetchPerpsHistory } from "./client";
import { historyRows, type HistoryMetric } from "./model";

/** The coin a pair names: BTC-USD charts the BTC perpetual. */
function baseAsset(ticker: string): string {
  return ticker.trim().toUpperCase().split(/[-/]/)[0] ?? ticker;
}

const METRICS: ReadonlyArray<{ metric: HistoryMetric; name: string; unit: string; scale: number; tags: readonly string[] }> = [
  { metric: "funding", name: "Perpetual funding rate (8h)", unit: "%", scale: 100, tags: ["funding", "carry"] },
  { metric: "oi", name: "Perpetual open interest", unit: "USD", scale: 1, tags: ["open interest", "OI", "leverage"] },
  { metric: "premium", name: "Perpetual premium to index", unit: "%", scale: 100, tags: ["premium", "basis"] },
];

/**
 * A coin's main perpetual contract, as the perps pane picks it, by the
 * history its detail charts: funding, open interest and premium.
 */
export const PERP_SERIES: readonly SeriesDefinition[] = METRICS.map(({ metric, name, unit, scale, tags }): SeriesDefinition => ({
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
      from: (start ?? new Date(Date.now() - 90 * 86_400_000)).toISOString(),
      resolution: "auto",
      limit: 5000,
    });
    return historyRows(history, metric).map((row) => ({ date: row.time, value: row.value == null ? null : row.value * scale }));
  },
}));
