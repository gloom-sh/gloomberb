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
