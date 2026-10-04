/** Power quantities are MW unless explicitly qualified in metrics; dates retain source precision. */
type PowerKind = "queue" | "load" | "capacity" | "utility"
type PowerStatus = "active" | "completed" | "withdrawn" | "approved" | "operating" | "unknown"
type PowerFuel = "solar" | "wind" | "storage" | "gas" | "nuclear" | "hydro" | "coal" | "hybrid" | "other" | "load" | "unknown"
interface PowerRecord {
  id: string
  sourceId: string
  sourceProjectId: string
  kind: PowerKind
  name: string
  country: string
  region: string
  state: string | null
  county: string | null
  zone: string | null
  developer: string | null
  utility: string | null
  fuel: PowerFuel
  technology: string | null
  status: PowerStatus
  statusRaw: string | null
  capacityMw: number | null
  requestedDate: string | null
  proposedDate: string | null
  completedDate: string | null
  withdrawnDate: string | null
  period: string | null
  asOf: string | null
  observedAt: string
  sourceUrl: string
  sourceLocator: string
  confidence: number
  /** Raw source cells or exact source excerpt. Never manufactured prose presented as a quote. */
  evidence: Record<string, unknown>
  /** Optional native facts e.g. generationMwh, customers, salesMwh, loadClass. */
  metrics: Record<string, string | number | boolean | null>
  /** Historical benchmarks never add to current direct-source queue totals. */
  historical: boolean
}
interface PowerEntityLink {
  name: string
  entityId: string
  tickers: { ticker: string; exchange?: string }[]
  confidence: number
  role: "developer" | "utility"
}
export interface PowerProject extends PowerRecord {
  snapshotId: string
  revision: number
  entities: PowerEntityLink[]
}
export interface PowerFilter {
  sort?: "capacityMw" | "name" | "region" | "status" | "proposedDate" | "generationMwh" | "salesMwh" | "revenueUsd" | "summerPeakDemandMw" | "winterPeakDemandMw"
  direction?: "asc" | "desc"
  country?: string
  region?: string
  fuel?: string
  status?: string
  kind?: string
  symbol?: string
  search?: string
  loadClass?: string
  sourceId?: string
  historical?: boolean
  offset?: number
  limit?: number
  from?: string
  to?: string
}
export interface PowerAggregate {
  sourceId: string
  country: string
  region: string
  fuel: string
  status: string
  kind: string
  projects: number
  capacityMw: number
  unknownCapacity: number
}
export interface PowerHistoryPoint extends PowerAggregate {
  basis: "observed" | "published"
  sourceUrls: string[]
  sourceId: string
  observedAt: string
  asOf: string | null
  period: string | null
  historical: boolean
}
export interface PowerCoverage {
  id: string
  country: string
  region: string
  kind: PowerKind
  role: "direct" | "benchmark" | "context"
  status: "current" | "stale" | "pending" | "failed" | "disabled"
  reason: string | null
  sourceUrl: string
  asOf: string | null
  observedAt: string | null
  records: number
  nextPollAt: string | null
}
export interface PowerRates {
  sourceId: string
  region: string
  country: string
  cohort: string
  projects: number
  completed: number
  withdrawn: number
  active: number
  unknown: number
  completionRate: number | null
  withdrawalRate: number | null
}
export interface PowerExposure {
  sourceId: string
  sourceUrls: string[]
  asOf: string | null
  observedAt: string
  utility: string
  country: string
  region: string
  requestedMw: number
  approvedMw: number
  operatingMw: number
  requests: number
  unknownCapacity: number
  entities: PowerEntityLink[]
}
export interface PowerBoard {
  generatedAt: string
  access: "full" | "preview"
  projects: PowerProject[]
  total: number
  hasMore: boolean
  nextOffset: number | null
  aggregates: PowerAggregate[]
  rates: PowerRates[]
  exposure: PowerExposure[]
  coverage: PowerCoverage[]
  filters: { countries: string[]; regions: string[]; fuels: string[]; statuses: string[] }
  locked: { projects: number; aggregates: number; rates: number; exposure: number }
}

export interface PowerHistory { generatedAt: string; access: "full" | "preview"; points: PowerHistoryPoint[]; locked: number; hasMore: boolean; nextOffset: number | null }
export interface PowerDetail { generatedAt: string; access: "full" | "preview"; project: PowerProject | null; revisions: PowerProject[]; totalRevisions: number; hasMore: boolean; nextOffset: number | null; locked: number }
