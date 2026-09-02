import { chartSeriesProvider } from "../../../capabilities";
import type { ChartSeriesCatalogItem, ChartSeriesCapability } from "../../../capabilities";
import { colors } from "../../../theme/colors";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import { buildValuationSeries } from "./align";
import { defaultValuationSeriesLoader, type ValuationSeriesLoader } from "./client";
import { indicatorSeries, type IndicatorDef } from "./defs";
import { findIndicator, INDICATORS } from "./indicators";
import type { DatedSeries } from "./series";

export const MARKET_VALUATION_CAPABILITY_ID = "market-valuation";

function catalogItem(indicator: IndicatorDef): ChartSeriesCatalogItem {
  return {
    seriesId: indicator.id,
    label: indicator.label,
    description: indicator.description,
    detail: "Market valuation",
    style: "line",
  };
}

function matches(indicator: IndicatorDef, query: string): boolean {
  const haystack = `${indicator.id} ${indicator.label} ${indicator.shortLabel} ${indicator.description}`;
  return haystack.toLowerCase().includes(query);
}

/**
 * A ratio is not a series anyone can fetch, so the pane's own computation is what
 * makes it chartable. Exposing it here lets G overlay, say, the Buffett indicator
 * against CPI without the pane being involved.
 */
export function createValuationChartSeriesCapability(
  loader: ValuationSeriesLoader = defaultValuationSeriesLoader,
): ChartSeriesCapability {
  return chartSeriesProvider({
    id: MARKET_VALUATION_CAPABILITY_ID,
    name: "Market Valuation",
    provider: {
      catalog: ({ limit }) => INDICATORS.slice(0, limit ?? INDICATORS.length).map(catalogItem),
      search: ({ query, limit }) => {
        const needle = query?.trim().toLowerCase();
        const hits = needle
          ? INDICATORS.filter((indicator) => matches(indicator, needle))
          : [...INDICATORS];
        return hits.slice(0, limit ?? hits.length).map(catalogItem);
      },
      resolve: async ({ seriesId }) => resolveValuationSeries(seriesId, loader),
    },
  });
}

export async function resolveValuationSeries(
  seriesId: string,
  loader: ValuationSeriesLoader = defaultValuationSeriesLoader,
): Promise<ResolvedSeries> {
  const indicator = findIndicator(seriesId);
  if (indicator.id !== seriesId.trim().toLowerCase()) {
    throw new Error(`Unknown valuation series ${seriesId}`);
  }

  const legs = new Map<string, DatedSeries>();
  await Promise.all(indicatorSeries(indicator).map(async (def) => {
    legs.set(def.key, await loader(def));
  }));

  const built = buildValuationSeries(indicator, legs);
  const points: TimeSeriesPoint[] = built.points.map((point) => {
    const date = new Date(point.date);
    return { date, observedAt: date, value: point.ratio };
  });

  return {
    id: `market-valuation:${indicator.id}`,
    label: indicator.label,
    color: colors.textBright,
    // Percent-scaled ratios share an axis with each other, never with a price.
    unit: indicator.ratioScale === 100 ? "%" : "x",
    unitGroup: indicator.ratioScale === 100 ? "valuation-percent" : "valuation-ratio",
    nativeFrequency: "daily",
    dataShape: "scalar",
    style: "line",
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: "none",
    points,
  };
}
