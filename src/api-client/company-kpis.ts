type QuoteMatchMode = "exact" | "whitespace" | "nfkc_whitespace";

type KpiBasis = "reported" | "adjusted" | "constant_currency" | "organic"
export type KpiUnit = "currency" | "currency_per_share" | "currency_per_unit" | "percent" | "basis_points" | "count" | "ratio" | "volume"
type KpiSourceKind = "press_release" | "filing" | "transcript" | "opendart" | "ir" | "esef" | "edinet"
type GuidanceDirection = "raised" | "cut" | "reiterated" | "mixed" | "initiated" | "withdrawn" | "not_comparable"
type GuidanceHedge = "exact" | "approximately" | "at_least" | "at_most" | "greater_than" | "less_than" | "qualitative" | "withdrawn"

export interface KpiPeriod {
  /** ISO dates; a quarter's dates must never be inferred from its fiscal label. */
  start: string | null
  end: string | null
  kind: "quarter" | "half" | "year" | "ytd" | "instant" | "other"
  fiscalYear: number | null
  fiscalQuarter: number | null
  label: string
}
interface KpiMetric {
  id: string
  name: string
  sector: string
  unit: KpiUnit
  definition: string
  aliases: Record<string, string[]>
  /** Economic preference, independent of whether the numeric guide was raised. */
  favorable: "higher" | "lower" | "neutral"
}
export interface KpiEvidence {
  id: string
  documentId: string
  sourceId: string
  sourceKind: KpiSourceKind
  url: string
  title: string
  publishedAt: string
  country: string
  language: string
  quote: string
  quoteOffset: number
  quoteSourceLength: number
  quoteMatchMode: QuoteMatchMode
  confidence: number
}
interface KpiObservationInput {
  metricId: string
  period: KpiPeriod
  value: number
  valueQualifier?: "exact" | "approximately" | "at_least" | "at_most" | "greater_than" | "less_than"
  unit: KpiUnit
  currency: string | null
  /** Scale of the supplied numeric value (1e6 means millions). Stored values use scale 1. */
  scale?: number
  basis: KpiBasis
  /** Named segment, geography, product, cohort, denominator or physical volume unit. */
  dimensions: Record<string, string>
  quote: string
  confidence: number
  /** Required when an actual explicitly restates a prior disclosed observation. */
  revisionReason?: string | null
}
interface KpiGuidanceInput extends Omit<KpiObservationInput, "value" | "valueQualifier"> {
  issuedDate: string
  low: number | null
  high: number | null
  point: number | null
  hedge: GuidanceHedge
  /** Exact source phrasing, including qualitative ranges and conditions. */
  rangeText: string
  conditions?: string | null
  status: "active" | "withdrawn"
}
export interface KpiObservation extends Omit<KpiObservationInput, "quote" | "scale"> {
  id: string
  symbol: string
  metric: KpiMetric
  seriesKey: string
  asOf: string
  supersedesId: string | null
  revision: number
  current: boolean
  conflict: boolean
  contested?: boolean
  evidence: KpiEvidence[]
}
export interface KpiGuidance extends Omit<KpiGuidanceInput, "quote" | "scale"> {
  id: string
  symbol: string
  metric: KpiMetric
  seriesKey: string
  asOf: string
  supersedesId: string | null
  revision: number
  current: boolean
  evidence: KpiEvidence[]
  direction: GuidanceDirection
  previousId: string | null
  midpointChangePct: number | null
  actual: { observationId: string; value: number; outcome: "above" | "below" | "within"; favorable: "beat" | "miss" | "in_line" | "neutral"; difference: number; differencePct: number | null } | null
}
interface KpiCoverage {
  country: string | null
  languages: string[]
  documents: number
  observations: number
  guidance: number
  firstPeriod: string | null
  lastPeriod: string | null
  lastPublishedAt: string | null
  sourceKinds: KpiSourceKind[]
  conflicts: number
}
export interface KpiSeries {
  key: string
  metric: KpiMetric
  unit: KpiUnit
  currency: string | null
  basis: KpiBasis
  dimensions: Record<string, string>
  latest: KpiObservation
  observations: KpiObservation[]
}
export interface KpisPayload {
  symbol: string
  status: "available" | "unavailable"
  asOf: string | null
  coverage: KpiCoverage
  series: KpiSeries[]
  /** Immutable prior actuals, including unresolved conflicting disclosures. */
  revisions: KpiObservation[]
  dictionary: KpiMetric[]
  access: "full" | "preview"
  lockedRows: number
  totalRows: number
  truncated: boolean
  previewRows: number | null
  methodology: string
}
export interface GuidancePayload extends Omit<KpisPayload, "series" | "revisions"> {
  guidance: KpiGuidance[]
  history: KpiGuidance[]
}
export interface KpiQueryOptions {
  metric?: string
  basis?: KpiBasis
  from?: string
  to?: string
  /** Point-in-time publication cutoff; excludes later restatements and actuals. */
  asOf?: string
}
export function companyDisclosurePath(section: "kpis" | "guidance", symbol: string, options: KpiQueryOptions): string {
  const query = new URLSearchParams(Object.entries(options).filter((entry): entry is [string, string] => entry[1] != null));
  return `/cloud/company-${section}/${encodeURIComponent(symbol)}?${query}`;
}
