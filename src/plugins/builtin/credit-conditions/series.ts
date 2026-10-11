import { fredSeriesUrl } from "../../../sources/gloomberb-cloud/fred-series";
import type { SeriesDefinition } from "../../../series/types";

/** Corporate bond option-adjusted spreads by rating, and the effective yields of both indexes. */
const ROWS: ReadonlyArray<readonly [seriesId: string, name: string, tags: readonly string[]]> = [
  ["BAMLC0A0CM", "US investment grade corporate OAS", ["spread", "IG", "investment grade"]],
  ["BAMLC0A1CAAA", "AAA corporate OAS", ["spread", "AAA", "investment grade"]],
  ["BAMLC0A2CAA", "AA corporate OAS", ["spread", "AA", "investment grade"]],
  ["BAMLC0A3CA", "A corporate OAS", ["spread", "single A", "investment grade"]],
  ["BAMLC0A4CBBB", "BBB corporate OAS", ["spread", "BBB", "investment grade"]],
  ["BAMLH0A0HYM2", "US high yield OAS", ["spread", "HY", "high yield", "junk"]],
  ["BAMLC0A0CMEY", "US investment grade corporate effective yield", ["yield", "IG", "investment grade"]],
  ["BAMLH0A0HYM2EY", "US high yield effective yield", ["yield", "HY", "high yield", "junk"]],
];

export const CREDIT_SPREAD_SERIES: readonly SeriesDefinition[] = ROWS.map(([seriesId, name, tags]) => ({
  id: `fred:${seriesId}`,
  name,
  unit: "%",
  frequency: "daily",
  group: "Credit",
  tags: [...tags, "corporate bonds"],
  publisher: "FRED",
  url: fredSeriesUrl(seriesId),
  expression: `FRED:${seriesId}`,
}));
