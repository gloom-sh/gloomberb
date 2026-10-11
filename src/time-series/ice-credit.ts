/**
 * The ICE BofA credit indexes FRED publishes and Gloom Cloud serves: option
 * adjusted spreads by rating and region, and two effective yields, all in
 * percent. One list for the CRD board, the data catalog, `fred`'s basis point
 * text and FRED's coverage notice. FRED publishes no euro investment grade
 * (ICE BofA Euro Corporate) spread, so the euro row is high yield only.
 */
export interface IceCreditSeries {
  seriesId: string;
  /** The CRD board's row. */
  label: string;
  /** The data catalog's name. */
  name: string;
  measure: "spread" | "yield";
  region: "us" | "euro";
  tags: readonly string[];
}

const HIGH_YIELD = ["high yield", "junk"];

export const ICE_CREDIT_SERIES: readonly IceCreditSeries[] = [
  { seriesId: "BAMLC0A0CM", label: "US IG", name: "US investment grade corporate OAS", measure: "spread", region: "us", tags: ["IG", "investment grade"] },
  { seriesId: "BAMLC0A1CAAA", label: "AAA", name: "AAA corporate OAS", measure: "spread", region: "us", tags: ["AAA", "investment grade"] },
  { seriesId: "BAMLC0A2CAA", label: "AA", name: "AA corporate OAS", measure: "spread", region: "us", tags: ["AA", "investment grade"] },
  { seriesId: "BAMLC0A3CA", label: "A", name: "A corporate OAS", measure: "spread", region: "us", tags: ["single A", "investment grade"] },
  { seriesId: "BAMLC0A4CBBB", label: "BBB", name: "BBB corporate OAS", measure: "spread", region: "us", tags: ["BBB", "investment grade"] },
  { seriesId: "BAMLH0A0HYM2", label: "US HY", name: "US high yield OAS", measure: "spread", region: "us", tags: ["HY", ...HIGH_YIELD] },
  { seriesId: "BAMLH0A1HYBB", label: "BB", name: "BB high yield OAS", measure: "spread", region: "us", tags: ["BB", "HY", ...HIGH_YIELD] },
  { seriesId: "BAMLH0A2HYB", label: "B", name: "Single-B high yield OAS", measure: "spread", region: "us", tags: ["single B", "HY", ...HIGH_YIELD] },
  { seriesId: "BAMLH0A3HYC", label: "CCC", name: "CCC and lower high yield OAS", measure: "spread", region: "us", tags: ["CCC", "HY", "distressed", ...HIGH_YIELD] },
  { seriesId: "BAMLHE00EHYIOAS", label: "Euro HY", name: "Euro high yield OAS", measure: "spread", region: "euro", tags: ["euro", "EUR", "Europe", "HY", ...HIGH_YIELD] },
  { seriesId: "BAMLC0A0CMEY", label: "US IG yld", name: "US investment grade corporate effective yield", measure: "yield", region: "us", tags: ["IG", "investment grade"] },
  { seriesId: "BAMLH0A0HYM2EY", label: "US HY yld", name: "US high yield effective yield", measure: "yield", region: "us", tags: ["HY", ...HIGH_YIELD] },
];

export const ICE_CREDIT_SERIES_IDS: ReadonlySet<string> = new Set(ICE_CREDIT_SERIES.map((series) => series.seriesId));

/** The option-adjusted spreads, which FRED serves in percentage points. */
export const ICE_SPREAD_SERIES: readonly IceCreditSeries[] = ICE_CREDIT_SERIES.filter((series) => series.measure === "spread");
