type EvidenceTier = "structured" | "primary" | "secondary" | "imported";

export type ExposureRange = { low: number; high: number }
export type ExposureBasis =
  | "revenue"
  | "cost"
  | "purchases"
  | "receivables"
  | "operating_income"
  | "interest_expense"
  | "debt"
type ExposureShockKind =
  | "country"
  | "commodity"
  | "rate"
  | "fx"
  | "tariff"
  | "supplier"
  | "customer"
/** Percentages are percentage points. Weights alone are fractions of NAV. */
interface ExposureShock {
  id: string
  kind: ExposureShockKind
  /** ISO country/currency code, commodity, or exact entity id/ticker/name. */
  target: string
  changePct?: number
  changeBps?: number
  /** Optional product restriction, e.g. a country export ban on semiconductors. */
  products?: string[]
  /** An explicit user assumption, never represented as a sourced disclosure. */
  transmission?: {
    basis: ExposureBasis
    exposurePct: ExposureRange
    /** Change in the denominator per unit change in the shock. */
    factor: ExposureRange
    direction?: 1 | -1
  }
}
export interface ExposureScenario {
  id?: string
  label: string
  shocks: ExposureShock[]
}
export interface ExposureHolding {
  symbol: string
  /** Signed fraction of NAV; 0.25 = 25%, -0.1 = 10% short. */
  weight: number
}
export interface ExposureRequest {
  holdings: ExposureHolding[]
  scenario: ExposureScenario
  depth?: number
  /** Cash weight in NAV fractions, never used to renormalize holding weights. */
  cashWeight?: number
}
export interface ExposureEvidence {
  id: string
  source: string
  tier: EvidenceTier | "profile" | "user"
  url: string | null
  quote: string | null
  asOf: string | null
  period: string | null
  units: string
  currency: string | null
  confidence: number | null
  /** Corrections must supersede explicitly; adapters return the current revision. */
  revision?: string | null
}
export interface ExposureExtensionObservation {
  id: string
  label: string
  kind: "kpi" | "credit" | "guidance"
  value: number | null
  units: string
  evidence: ExposureEvidence[]
  currency?: string | null
  period?: string | null
  asOf?: string | null
  basis?: string
  dimensions?: Record<string, string>
  qualifier?: string
  range?: { low: number | null; high: number | null }
  valueText?: string
  status?: string
  notes?: string[]
  sensitivity?: {
    kind: ExposureShockKind
    target: string
    basis: ExposureBasis
    period: string
    exposurePct: ExposureRange
    factor: ExposureRange
    direction: 1 | -1
  } | null
}
interface ExposurePathHop {
  from: { id: string; name: string; symbol: string | null; country: string | null }
  to: { id: string; name: string; symbol: string | null; country: string | null }
  evidence: ExposureEvidence[]
  pct: number | null
  basis: ExposureBasis | null
  denominatorEntityId: string | null
}
export interface ExposureComponent {
  id: string
  shockId: string
  label: string
  channel: "geography" | "product" | "supplier" | "customer" | "profile" | "assumption" | "extension"
  order: number
  basis: ExposureBasis | null
  period: string | null
  classification: "disclosed" | "estimated" | "unknown"
  exposurePct: ExposureRange | null
  /** Estimated operating-denominator change; never a stock-return forecast. */
  impactPct: ExposureRange | null
  proportionalEstimatePct?: number | null
  evidence: ExposureEvidence[]
  path: ExposurePathHop[]
  unknowns: string[]
  /** Used only internally for validated disjoint revenue partitions. */
  partition?: string | null
}
interface ExposureMeasure {
  shockId: string
  basis: ExposureBasis
  period: string
  exposurePct: ExposureRange
  impactPct: ExposureRange | null
  classification: "disclosed" | "estimated"
  componentIds: string[]
  /** True when an unquantified matching relationship prevents a complete bound. */
  incomplete: boolean
}
interface ExposureHoldingResult {
  symbol: string
  name: string | null
  weight: number
  status: "quantified" | "partial" | "unknown"
  measures: ExposureMeasure[]
  components: ExposureComponent[]
  extensions: ExposureExtensionObservation[]
  unknowns: string[]
  coverage: {
    revenueRows: number
    graphNodes: number
    graphLinks: number
    matchedPaths: number
    quantifiedComponents: number
    unknownComponents: number
    graphComplete: boolean
    oldestEvidenceAt: string | null
    latestEvidenceAt: string | null
  }
}
interface ExposurePortfolioMeasure {
  shockId: string
  basis: ExposureBasis
  period: string
  /** Holding-weighted operating exposure, in NAV-weighted percentage points. */
  signedExposurePct: ExposureRange
  grossExposurePct: ExposureRange
  impactPct: ExposureRange | null
  coveredGrossWeight: number
  unknownGrossWeight: number
  symbols: string[]
}
interface ExposureConcentration {
  kind: "country" | "supplier" | "customer"
  key: string
  label: string
  basis: ExposureBasis | null
  period: string | null
  grossExposurePct: ExposureRange | null
  signedExposurePct: ExposureRange | null
  grossHoldingWeight: number
  symbols: string[]
  evidence: ExposureEvidence[]
  incomplete: boolean
}
export interface ExposurePayload {
  version: 1
  scenario: ExposureScenario
  evaluatedAt: string
  access: "full" | "preview"
  depth: number
  requestedHoldings: number
  lockedHoldings: number
  holdings: ExposureHoldingResult[]
  portfolio: {
    grossWeight: number
    netWeight: number
    cashWeight: number | null
    /** 1 - net holding weights - explicit cash, financing/residual if not zero. */
    residualWeight: number
    measures: ExposurePortfolioMeasure[]
    concentrations: ExposureConcentration[]
    unknownGrossWeight: number
  }
  unknowns: string[]
  methodology: string[]
}
