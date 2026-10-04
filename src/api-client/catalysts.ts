type QuoteMatchMode = "exact" | "whitespace" | "normalized"

export const CATALYST_TYPES = ["regulatory", "clinical", "litigation", "antitrust", "recall", "sanctions", "export_control", "tariff", "rulemaking", "approval", "advisory", "pdufa"] as const
export type CatalystType = (typeof CATALYST_TYPES)[number]
type DatePrecision = "day" | "month" | "year"
interface CatalystIdentifiers {
  cik?: string
  lei?: string
  isin?: string
  tickers?: Array<{ ticker: string; exchange?: string | null }>
  [key: string]: unknown
}
interface CatalystPartyInput {
  name: string
  role?: string
  identifiers?: CatalystIdentifiers
}
interface CatalystParty extends CatalystPartyInput {
  entityId: string | null
  ticker: string | null
  exchange: string | null
  resolution: "identifier" | "alias" | "unresolved"
  confidence: number
}
interface CatalystOpinion {
  label: "Model opinion"
  direction: "positive" | "negative" | "mixed" | "uncertain"
  type: CatalystType
  rationale: string
  quote: string
  quoteOffset: number
  quoteSourceLength: number
  quoteMatchMode: QuoteMatchMode
  confidence: number
  model: string
  gateModel: string
  generatedAt: string
  promptVersion: string
}
interface CatalystInput {
  source: string
  externalId: string
  type: CatalystType
  agency: string
  jurisdiction: string
  country?: string | null
  title: string
  summary: string
  status: string
  announcedDate?: string | null
  effectiveDate?: string | null
  deadlineDate?: string | null
  datePrecision?: { announced?: DatePrecision; effective?: DatePrecision; deadline?: DatePrecision }
  parties: CatalystPartyInput[]
  sourceUrl: string
  sourceDocumentId?: string | null
  language?: string
  observedAt: string
  sourcePublishedAt?: string | null
  quote?: string | null
  /** Kept privately for evidence validation and repeatable extraction. */
  sourceText?: string
  confidence: number
  metadata?: Record<string, unknown>
  sector?: string | null
  opinion?: CatalystOpinion | null
}
interface CatalystChange { field: string; before: unknown; after: unknown }
export interface CatalystEvent extends Omit<CatalystInput, "parties" | "sourceText"> {
  id: string
  revisionId: string
  revision: number
  parties: CatalystParty[]
  announcedDate: string | null
  effectiveDate: string | null
  deadlineDate: string | null
  datePrecision: NonNullable<CatalystInput["datePrecision"]>
  country: string | null
  sector: string | null
  language: string
  quote: string | null
  quoteOffset: number | null
  quoteSourceLength: number | null
  quoteMatchMode: QuoteMatchMode | null
  opinion: CatalystOpinion | null
  changes: CatalystChange[]
  supersedesRevisionId: string | null
  firstSeenAt: string
  lastSeenAt: string
}
export interface CatalystFilters {
  symbol?: string
  type?: CatalystType
  agency?: string
  country?: string
  sector?: string
  status?: string
  source?: string
  search?: string
  from?: string
  to?: string
  dateField?: "announced" | "effective" | "deadline" | "observed" | "any"
  upcoming?: boolean
  changed?: boolean
  litigation?: boolean
  limit?: number
  offset?: number
}
interface CatalystSource {
  id: string
  name: string
  agency: string
  jurisdiction: string
  country: string
  enabled: boolean
  disabledReason?: string
  homepage: string
  termsUrl?: string
  cadenceMinutes: number
  coverage: string
}
interface CatalystSourceState {
  source: string
  lastOkAt: string | null
  lastAttemptAt: string | null
  nextPollAt: string | null
  failures: number
  lastError: string | null
  cursor: string | null
  etag: string | null
  lastModified: string | null
  eventsSeen: number
}
interface CatalystCoverage {
  sources: Array<CatalystSource & { state: CatalystSourceState | null; events: number }>
  totalEvents: number
  linkedEvents: number
  unresolvedParties: number
  jurisdictions: string[]
  firstObservedAt: string | null
  lastObservedAt: string | null
}
export interface CatalystResponse {
  events: CatalystEvent[]
  total: number
  limit: number
  offset: number
  asOf: string
  filters: CatalystFilters
  coverage: CatalystCoverage
  facets: { types: string[]; agencies: string[]; countries: string[]; sectors: string[]; statuses: string[] }
  access?: { pro: boolean; lockedRows: number; previewLimit: number }
}
export interface CatalystDetail { event: CatalystEvent; history: CatalystEvent[]; historyTotal?: number; historyTruncated?: boolean; historyOffset?: number; historyLimit?: number; historyHasMore?: boolean; asOf: string; access?: { pro: boolean; lockedRows: number; previewLimit: number } }
export interface CatalystStatus {
  ready: boolean
  coverage: CatalystCoverage
}

export interface CatalystChanges extends CatalystResponse { nextCursor: string | null; hasMore: boolean }
