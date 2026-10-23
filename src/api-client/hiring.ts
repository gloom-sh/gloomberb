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
 * roles say nothing about hiring (docs/hiring-app-attention.md, Moves).
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

/**
 * Why a move is held from alerts and ranked after the others: one day carried
 * most of its new roles, its boards were read too seldom to tell a steady
 * rise from a batch, or it is more roles than the boards ever held open.
 */
export type HiringMoveFlag = "one_day_batch" | "few_reads" | "outsized"

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
  /** Absent from a server before flags. */
  flags?: HiringMoveFlag[]
  /** The day with the most new roles that week, and how many. */
  peakDay?: { day: string; newRoles: number } | null
  /** A board that cannot place its new roles on a day: its reads that week and the days they counted. */
  unplacedRead?: { reads: number; days: number | null } | null
  /** The most roles the company's boards held open in a week before. */
  priorMaxOpen?: number | null
  why: string
  firstComputedAt: string
  computedAt: string
  /** Since when the current signal has held; it alerts once a pass 12 hours on keeps it. */
  signalSince?: string
  confirmed?: boolean
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
  /** A free read is always the own moves, whatever was asked. */
  filter?: HiringMovesFilter
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
  /** `move`: a free read of a company off the free board keeps its week, not its move. */
  locked: { history: number; added: number; closed: number; move?: number }
}

/**
 * HIRE's Expansion and Anomalies tabs: a company's first roles in a country
 * or city, one place or role family far above its own weeks, and role
 * families it never posted, in the latest complete week.
 */
export type HiringSignalGroup = "expansion" | "anomalies"
export type HiringSignalKind = "new_country" | "new_city" | "location_spike" | "function_spike" | "new_role_type"
export type HiringSignalsFilter = "all" | HiringSignalKind
/** Why a company's week gives no signal at all. */
export type HiringSignalHold = "unmeasured" | "short_watch" | "recounted"
/** Why a kind was not looked for at a company, or a first or a spike was dropped. */
export type HiringSignalSkip = "thin_history" | "unplaced_history" | "unplaced_cities" | "unclassified_history" | "reformatted" | "posted_before_watch" | "similar_city" | "one_day"
/** A spike shown last: a seldom-read board, or a week Moves flagged. */
export type HiringSignalFlag = "few_reads" | "one_day_batch"

export interface HiringWeekSignal {
  symbol: string
  name: string
  sector: string | null
  industry: string | null
  sourceTickers: string[]
  week: string
  kind: HiringSignalKind
  group: HiringSignalGroup
  dimension: "country" | "city" | "function"
  /** `MX`, `austin|US`, `data_ai`. */
  key: string
  /** `Mexico`, `Austin, TX, US`, `Data & AI`. */
  label: string
  country: string | null
  newRoles: number
  titles: number
  /** How far back "never" goes: every board read since `watchedSince`, and the postings seen before the week. */
  history: { watchedSince: string; priorPostings: number; priorShare: number | null }
  /** A spike's weeks before; `values` is empty in a free read. */
  baseline: { weeks: number; mean: number; values: Array<{ week: string; newRoles: number }> } | null
  ratio: number | null
  zScore: number | null
  /** The company's own pace in the same terms, for a spike. */
  companyRatio: number | null
  flags: HiringSignalFlag[]
  reads: number | null
  topTitles: Array<{ title: string; count: number }>
  places: Array<{ label: string; count: number }>
  postings: HiringMovePosting[]
  why: string
  firstComputedAt: string
  computedAt: string
}

export interface HiringSignalsBoard {
  generatedAt: string
  proRequired: true
  preview: boolean
  group: HiringSignalGroup
  /** A free read is always the group's first three, whatever was asked. */
  filter: HiringSignalsFilter
  week: string | null
  total: number
  locked: number
  coverage: {
    measured: number
    counts: Partial<Record<HiringSignalKind, number>>
    held: Partial<Record<HiringSignalHold, number>>
    skipped: Partial<Record<HiringSignalSkip, number>>
    /** The earliest and latest first read of a measured company: how far back "never" goes. */
    watchedFrom: string | null
    watchedTo: string | null
    computedAt: string | null
  }
  signals: HiringWeekSignal[]
}

export interface HiringCompanySignals {
  generatedAt: string
  proRequired: true
  preview: boolean
  symbol: string
  requestedSymbol?: string
  name: string | null
  week: string | null
  watchedSince: string | null
  held: HiringSignalHold | null
  skipped: HiringSignalSkip[]
  /** The latest week's signals, both groups. */
  signals: HiringWeekSignal[]
  history: HiringWeekSignal[]
  /** What a free read holds back: this week's, earlier weeks', and both by tab. Absent by tab from a server before it. */
  locked: { signals: number; history: number } & Partial<Record<HiringSignalGroup, number>>
}

/**
 * HIRE's Building tab: the role families and themes whose share of a
 * company's new roles rose against its own weeks before, and each company's
 * whole mix, recent weeks against the weeks before.
 */
type HiringBuildingDimension = "function" | "theme"
export type HiringBuildingFilter = "all" | HiringBuildingDimension
/** Why a company has no mix to compare. */
export type HiringBuildingHold = "shared_board" | "unmeasured" | "recounted" | "rescoped" | "short_watch" | "thin"
/** Compared in part: no family mix, or some themes not yet read. */
export type HiringBuildingSkip = "unclassified" | "unread_titles"

export interface HiringMixRow {
  dimension: HiringBuildingDimension
  /** `sales`, `ai_ml`. */
  key: string
  /** `Sales`, `AI & machine learning`. */
  label: string
  recentRoles: number
  /** Of the recent weeks' roles with a role family (a family), or of all of them (a theme). */
  recentShare: number
  beforeRoles: number
  beforeShare: number
  change: number
  /** A theme whose titles have all been read; a family always is. */
  read: boolean
}

interface HiringBuildingWeek { week: string; roles: number; classified: number }

export interface HiringBuildingShift {
  symbol: string
  name: string
  sector: string | null
  industry: string | null
  sourceTickers: string[]
  week: string
  dimension: HiringBuildingDimension
  key: string
  label: string
  /** `values` is empty in a free read. */
  recent: { weeks: number; roles: number; total: number; share: number; values: Array<{ week: string; roles: number; total: number }> }
  before: { weeks: number; roles: number; total: number; share: number; values: Array<{ week: string; roles: number; total: number }> }
  change: number
  ratio: number | null
  zScore: number
  titles: number
  topTitles: Array<{ title: string; count: number }>
  postings: HiringMovePosting[]
  why: string
  firstComputedAt: string
  computedAt: string
}

export interface HiringBuildingBoard {
  generatedAt: string
  proRequired: true
  preview: boolean
  /** A free read is always the first three, whatever was asked. */
  filter: HiringBuildingFilter
  week: string | null
  total: number
  locked: number
  coverage: {
    measured: number
    counts: Partial<Record<HiringBuildingDimension, number>>
    held: Partial<Record<HiringBuildingHold, number>>
    skipped: Partial<Record<HiringBuildingSkip, number>>
    /** Theme titles in the weeks compared, and how many the model has read. */
    themeTitles: { titles: number; read: number }
    computedAt: string | null
  }
  shifts: HiringBuildingShift[]
}

export interface HiringCompanyBuilding {
  generatedAt: string
  proRequired: true
  preview: boolean
  symbol: string
  requestedSymbol?: string
  name: string | null
  week: string | null
  held: HiringBuildingHold | null
  skipped: HiringBuildingSkip[]
  window: { recent: HiringBuildingWeek[]; before: HiringBuildingWeek[] } | null
  functions: HiringMixRow[]
  themes: HiringMixRow[]
  shifts: HiringBuildingShift[]
  history: HiringBuildingShift[]
  locked: { functions: number; themes: number; shifts: number; history: number }
}
