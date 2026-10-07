/** Public-source financial amounts remain decimal strings through persistence and REST. */
export type AwardType = "prime" | "subaward" | "modification" | "notice"
interface AwardIdentifier {
  scheme: "uei" | "duns" | "cage" | "lei" | "source" | "cik"
  value: string
}
interface AwardRecipient {
  name: string
  identifiers?: AwardIdentifier[]
  country?: string | null
}
export interface AwardInput {
  source: string
  sourceAwardId: string
  sourceRevisionId?: string | null
  jurisdiction: string
  awardType: AwardType
  awardStatus?: string | null
  title: string
  description?: string | null
  awardDate: string
  dateBasis?: "award" | "publication" | "period-start"
  dataBasis?:
    | "api-award"
    | "api-search"
    | "api-combined"
    | "bulk-latest-transaction"
    | "bulk-transaction"
    | "api-transaction"
    | "combined-transaction"
  dataEffectiveDate?: string
  fieldAsOf?: Record<string, string>
  fieldSourceUrls?: Record<string, string>
  periodStart?: string | null
  periodEnd?: string | null
  fiscalYear?: number | null
  currency: string
  /** Cumulative award obligation. Never sum this with transaction flows. */
  obligatedAmount?: string | null
  ceilingAmount?: string | null
  /** Face value for awards; action amount for modification records. */
  awardAmount?: string | null
  recipient: AwardRecipient
  agency: { id?: string | null; name: string; parentName?: string | null }
  parentAwardId?: string | null
  parentSource?: string | null
  parentRecipient?: AwardRecipient | null
  transactionId?: string | null
  modificationNumber?: string | null
  actionType?: string | null
  classifications?: { scheme: string; code: string; label?: string }[]
  naics?: string | null
  psc?: string | null
  sector?: string | null
  placeOfPerformance?: {
    country?: string | null
    region?: string | null
    city?: string | null
  } | null
  sourceUrl: string
  publishedAt?: string | null
  sourceUpdatedAt?: string | null
  evidenceQuote?: string | null
  confidence?: number
  rawPayload?: unknown
}
interface AwardEntityMatch {
  ticker: string
  exchange: string | null
  legalName: string
  parentName: string | null
  cik: string | null
  method: "identifier" | "legal-name" | "verified-alias"
  evidenceUrl: string
  confidence: number
}
export interface AwardRow extends AwardInput {
  id: string
  revisionId: string
  observedAt: string
  entity: AwardEntityMatch | null
  revenueComparison: AwardRevenueComparison | null
}
interface AwardRevenueComparison {
  awardAmount: string
  annualRevenue: string
  currency: string
  periodStart: string
  periodEnd: string
  filedAt: string
  sourceUrl: string
  percent: number
  basis: "award-value" | "obligated"
}
export interface AwardFilter {
  ticker?: string
  parentId?: string
  jurisdiction?: string
  agency?: string
  sector?: string
  source?: string
  awardType?: AwardType
  currency?: string
  from?: string
  to?: string
  fiscalYear?: number
  query?: string
  minAmount?: string
  cursor?: string
  limit?: number
}
export interface AwardAggregate {
  source: string
  key: string
  label: string
  currency: string
  awardType: AwardType
  count: number
  obligatedAmount: string | null
  ceilingAmount: string | null
  awardAmount: string | null
  sharePercent: number | null
}
export interface AwardCompanyLeader extends AwardAggregate {
  sector: string
  ticker: string | null
  exchange: string | null
}
export interface AwardHistoryPoint {
  source: string
  month: string
  currency: string
  awardType: AwardType
  count: number
  obligatedAmount: string | null
  ceilingAmount: string | null
  awardAmount: string | null
  cumulativeObligatedAmount: string | null
}
interface AwardSourceState {
  source: string
  enabled: boolean
  lastAttemptAt: string | null
  lastOkAt: string | null
  nextPollAt: string | null
  failures: number
  lastError: string | null
  cursor: string | null
  coverageStart: string | null
  coverageEnd: string | null
  coverageComplete: boolean
  records: number
  requestsToday: number
}
interface AwardCoverage {
  source: string
  startDate: string
  endDate: string
  status: "pending" | "running" | "complete" | "failed"
  records: number
  pages: number
  cursor: string | null
  lastError: string | null
  updatedAt: string
}
export interface AwardsPayload {
  generatedAt: string
  asOf: string | null
  status: "available" | "partial" | "unavailable"
  access: "full" | "preview"
  rows: AwardRow[]
  nextCursor: string | null
  agencies: AwardAggregate[]
  sectors: AwardAggregate[]
  leaders: AwardCompanyLeader[]
  history: AwardHistoryPoint[]
  alerts: AwardRow[]
  sources: AwardSourceState[]
  coverage: AwardCoverage[]
  gaps: string[]
  locked: boolean
  truncated?: {
    agencies: boolean
    sectors: boolean
    history: boolean
    leaders: boolean
  }
}
interface AwardRevision {
  id: string
  observedAt: string
  sourceUpdatedAt: string | null
  supersedes: string | null
  award: AwardInput
}
interface AwardEdge {
  kind: "government-customer" | "subcontractor"
  from: AwardRecipient
  to: AwardRecipient
  awardId: string
  sourceUrl: string
  amount: string | null
  currency: string
}
export interface AwardDetailPayload {
  nextRevisionsCursor?: string | null
  truncated?: { revisions: boolean; subawards: boolean; modifications: boolean }
  row: AwardRow | null
  revisions: AwardRevision[]
  subawards: AwardRow[]
  modifications: AwardRow[]
  edges: AwardEdge[]
  access: "full" | "preview"
  locked: boolean
}
