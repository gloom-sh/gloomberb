import { fredSeriesUrl } from "../../../sources/gloomberb-cloud/fred-series";
import type { SeriesDefinition } from "../../../series/types";
import { ICE_CREDIT_SERIES } from "../../../time-series/ice-credit";

/** Corporate bond option-adjusted spreads by rating and region, and the effective yields of the US indexes. */
export const CREDIT_SPREAD_SERIES: readonly SeriesDefinition[] = ICE_CREDIT_SERIES.map((series) => ({
  id: `fred:${series.seriesId}`,
  name: series.name,
  unit: "%",
  frequency: "daily",
  group: "Credit",
  tags: [series.measure, ...series.tags, "corporate bonds"],
  publisher: "FRED",
  url: fredSeriesUrl(series.seriesId),
  expression: `FRED:${series.seriesId}`,
}));
