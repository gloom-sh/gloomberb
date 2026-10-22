/** HIRING is an observed requisition series, not headcount or job creation. */
interface HiringCompany {
  entityId: string
  symbol: string
  name: string
  sector: string | null
  mappingConfidence: number
  mappingSourceUrl: string | null
}

interface HiringPosting {
  id: string
  title: string
  url: string | null
  location: string | null
  country: string | null
  remote: boolean | null
  jobFunction: string | null
  seniority: string | null
  tags: string[]
  classifiedBy: string | null
  evergreen: boolean | null
}

interface HiringBucket {
  id: string
  label: string
  count: number
  share: number
}

interface HiringPoint {
  week: string
  observedAt: string
  openCount: number
  added: number | null
  removed: number | null
  netChange: number | null
  changePct: number | null
  remoteShare: number | null
  remoteKnown: number | null
  evergreenCount: number
  sourceCount: number
  completeness: "complete" | "partial" | "unknown"
  confidence: number
  kind: "observed" | "legacy_daily" | "mixed"
}

interface HiringSignal {
  type: "surge" | "freeze" | "new_location"
  label: string
  value: number
  asOf: string
  confidence: number
  location: string | null
  evidenceUrls: string[]
}

interface HiringEvidence extends HiringPosting {
  sourceTicker: string
  sourceUrl: string | null
  observedAt: string
  snapshotId: string
  revision: number
  confidence: number
}

export interface HiringSummary extends HiringCompany {
  latest: HiringPoint | null
  historyWeeks: number
  zScore: number | null
  signal: "surge" | "freeze" | null
  status: "ok" | "collecting" | "stale" | "uncovered"
}

export interface HiringPayload extends HiringSummary {
  generatedAt: string
  requestedSymbol?: string
  proRequired: true
  preview: boolean
  locked: { history: number; evidence: number; peers: number; signals: number; mix: number }
  series: HiringPoint[]
  functions: HiringBucket[]
  seniority: HiringBucket[]
  countries: HiringBucket[]
  locations: HiringBucket[]
  signals: HiringSignal[]
  peers: HiringSummary[]
  evidence: HiringEvidence[]
  coverage: {
    sourceTickers: string[]
    sourceUrls: string[]
    firstObservedAt: string | null
    lastObservedAt: string | null
    knownCountryShare: number | null
    classifiedShare: number | null
    remoteKnownShare: number | null
    comparability: string
  }
}

export interface HiringBoard {
  generatedAt: string
  requestedSymbol?: string
  proRequired: true
  preview: boolean
  total: number
  locked: number
  companies: HiringSummary[]
}

/**
 * Why a company's week is not measured: the collection changed, so its new
 * roles say nothing about hiring (docs/hiring.md, Hiring moves).
 */
export type HiringMoveExclusion =
  | "first_read" | "source_added" | "identity_reset" | "catch_up" | "retired" | "truncated" | "rediscovered"
  | "recipe_restored" | "careers_url_dropped" | "read_gap" | "collapsed" | "no_read" | "vendor_wide"

export interface HiringMoveWeek {
  week: string
  newRoles: number | null
  closedRoles: number | null
  openRoles: number | null
  reads: number
  measured: boolean
  excluded: HiringMoveExclusion[]
}

/** A company's new roles in one UTC week against its own measured weeks before and its peers'. */
export interface HiringMove {
  symbol: string
  name: string
  sector: string | null
  industry: string | null
  sourceTickers: string[]
  week: string
  newRoles: number
  closedRoles: number
  openRoles: number
  /** `values` is empty in a free read: the weeks are history. */
  baseline: { weeks: number; mean: number; sd: number; values: Array<{ week: string; newRoles: number }> }
  ratio: number | null
  zScore: number
  peers: { group: "industry" | "sector" | "universe"; label: string; companies: number; medianRatio: number | null }
  peerRelative: number | null
  direction: "accelerating" | "slowing" | null
  /** `with_peers`: the company moved, and so did its peers. */
  signal: "accelerating" | "slowing" | "with_peers" | null
  /** Role families behind the move, each scaled to the week's measured new roles. */
  drivers: Array<{ id: string; label: string; newRoles: number; baselineMean: number }>
  topTitles: Array<{ title: string; count: number }>
  why: string
  firstComputedAt: string
  computedAt: string
}

export interface HiringMovePosting {
  id: string
  title: string
  url: string | null
  location: string | null
  country: string | null
  jobFunction: string | null
  seniority: string | null
  firstSeenAt: string
  closedAt: string | null
  sourceTicker: string
}

export type HiringMovesFilter = "all" | "moves" | "accelerating" | "slowing"

export interface HiringMovesBoard {
  generatedAt: string
  proRequired: true
  preview: boolean
  week: string | null
  total: number
  locked: number
  coverage: {
    measured: number
    signals: { accelerating: number; slowing: number; withPeers: number }
    unmeasured: number
    unmeasuredReasons: Partial<Record<HiringMoveExclusion, number>>
    computedAt: string | null
    baselineWeeks: number
  }
  moves: HiringMove[]
}

export interface HiringCompanyMoves {
  generatedAt: string
  proRequired: true
  preview: boolean
  symbol: string
  requestedSymbol?: string
  name: string | null
  latest: HiringMove | null
  /** The latest week, measured or not. */
  week: HiringMoveWeek | null
  weeks: HiringMoveWeek[]
  history: Array<Pick<HiringMove, "week" | "newRoles" | "ratio" | "zScore" | "peerRelative" | "direction" | "signal" | "computedAt">>
  evidence: { added: HiringMovePosting[]; closed: HiringMovePosting[] }
  evidenceTotals: { added: number; closed: number }
  locked: { history: number; added: number; closed: number }
}
