import type { SeriesDefinition, SeriesLoadResult, SeriesPoint } from "../../../series/types";
import { savedCopyForTransientFailure } from "../../../data/plugin-cache";
import { cachedSeriesNote } from "../shared/series-warning";
import { loadFearGreed } from "./cache";
import type { FearGreedData } from "./data";

/** The index refreshes through the session; the pane's cache keeps a copy for five minutes. */
const REFRESH_MS = 5 * 60_000;

type Reading = (data: FearGreedData) => SeriesPoint[];

function component(id: string, pick: "primary" | "secondary"): Reading {
  return (data) => {
    const indicator = data.indicators.find((entry) => entry.definition.id === id);
    if (!indicator) throw new Error("This component is missing from the latest reading.");
    if (pick === "primary") return indicator.points.map((point) => ({ date: point.date, value: point.close }));
    return indicator.secondaryPoints.flatMap((point) => {
      const date = indicator.points[point.index]?.date;
      return date ? [{ date, value: point.value }] : [];
    });
  };
}

function series(id: string, name: string, unit: string, read: Reading, tags: readonly string[]): SeriesDefinition {
  return {
    id: `fear-greed:${id}`,
    name,
    unit,
    frequency: "daily",
    group: "Sentiment",
    tags: ["fear and greed", ...tags],
    refreshMs: REFRESH_MS,
    load: async (): Promise<SeriesLoadResult> => {
      // A saved copy answers only a failure asking again may get past; a refusal is the chart's error.
      const result = savedCopyForTransientFailure(await loadFearGreed());
      return { points: read(result.data),
        ...cachedSeriesNote({ ...result, ...(result.source === "stale-fallback" ? { savedAt: result.fetchedAt } : {}) }) };
    },
  };
}

/** The index and the seven readings it is built from, as the pane charts them. */
export const FEAR_GREED_SERIES: readonly SeriesDefinition[] = [
  series("index", "Fear & Greed index", "score", (data) => data.overall.history.map((point) => ({ date: point.date, value: point.close })), ["sentiment"]),
  series("market-momentum", "Fear & Greed: S&P 500 momentum", "index", component("market-momentum", "primary"), ["momentum", "S&P 500"]),
  series("market-momentum-average", "Fear & Greed: S&P 500 125-day average", "index", component("market-momentum", "secondary"), ["momentum", "moving average"]),
  series("stock-price-strength", "Fear & Greed: net new 52-week highs", "%", component("stock-price-strength", "primary"), ["breadth", "highs and lows"]),
  series("stock-price-breadth", "Fear & Greed: McClellan volume summation", "index", component("stock-price-breadth", "primary"), ["breadth", "McClellan"]),
  series("put-call-options", "Fear & Greed: 5-day put/call ratio", "ratio", component("put-call-options", "primary"), ["options", "put call"]),
  series("market-volatility", "Fear & Greed: VIX", "index", component("market-volatility", "primary"), ["volatility", "VIX"]),
  series("market-volatility-average", "Fear & Greed: VIX 50-day average", "index", component("market-volatility", "secondary"), ["volatility", "moving average"]),
  series("safe-haven-demand", "Fear & Greed: stocks minus bonds, 20-day return", "%", component("safe-haven-demand", "primary"), ["safe haven", "bonds"]),
  series("junk-bond-demand", "Fear & Greed: junk bond spread", "%", component("junk-bond-demand", "primary"), ["credit", "high yield", "junk"]),
];
