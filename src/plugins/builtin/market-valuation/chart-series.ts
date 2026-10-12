import type { SeriesDefinition, SeriesLoadResult } from "../../../series/types";
import { buildValuationSeries } from "./align";
import { defaultValuationSeriesLoader, type ValuationSeriesLoader } from "./client";
import { indicatorUnavailableReason, indicatorSeries, type IndicatorDef } from "./defs";
import { INDICATORS } from "./indicators";
import type { DatedSeries } from "./series";

/** `CAP:market-valuation:<indicator>`, the expression charts saved before the catalog had these. */
const MARKET_VALUATION_NAMESPACE = "market-valuation";

/** Shiller's series move once a month; the Z.1 and GDP ratios once a quarter. */
function indicatorFrequency(indicator: IndicatorDef): "monthly" | "quarterly" {
  return indicatorSeries(indicator).some((def) => def.source.kind === "shiller") ? "monthly" : "quarterly";
}

/**
 * A ratio is not a series anyone can fetch, so the pane's own computation is
 * what makes it chartable: overlaying the Buffett indicator on CPI needs no
 * valuation pane on screen.
 */
export async function loadValuationIndicator(
  indicator: IndicatorDef,
  loader: ValuationSeriesLoader = defaultValuationSeriesLoader,
): Promise<SeriesLoadResult> {
  const unavailable = indicatorUnavailableReason(indicator);
  if (unavailable) throw new Error(unavailable);
  const legs = new Map<string, DatedSeries>();
  await Promise.all(indicatorSeries(indicator).map(async (def) => {
    legs.set(def.key, await loader(def));
  }));

  const built = buildValuationSeries(indicator, legs);
  const warnings = [...legs].flatMap(([key, data]) => data.refreshError
    ? [`${key}: ${data.refreshError}`]
    : data.provider?.stale ? [`${key}: source data is stale`]
    : data.stale ? [`${key}: cached data is stale`] : []);
  if (built.points.at(-1)?.ratio == null) {
    warnings.push(`${indicator.label}: latest observation unavailable (${built.points.at(-1)!.date})`);
  }
  return {
    points: built.points.map((point) => ({ date: point.date, value: point.ratio })),
    ...(warnings.length ? { warning: warnings.join("; ") } : {}),
  };
}

export function valuationSeriesDefinitions(
  loader: ValuationSeriesLoader = defaultValuationSeriesLoader,
): SeriesDefinition[] {
  return INDICATORS.map((indicator) => ({
    id: `${MARKET_VALUATION_NAMESPACE}:${indicator.id}`,
    name: indicator.label,
    unit: indicator.axisUnit === "%" ? "%" : "x",
    frequency: indicatorFrequency(indicator),
    group: "Valuation",
    tags: [indicator.shortLabel, "market valuation"],
    description: indicator.description,
    load: () => loadValuationIndicator(indicator, loader),
  }));
}
