type AppStore = "app-store" | "google-play"
export type AppChart = "free" | "paid" | "grossing" | "unranked"

export interface AppAttentionFilter {
  symbol?: string
  country?: string
  chart?: AppChart
  category?: string
  days?: number
  limit?: number
  offset?: number
}
interface AppObservation {
  appId: string
  name: string
  developer: string
  developerId: string | null
  appUrl: string
  genres: string[]
  genreIds: string[]
  rank: number | null
  rating: number | null
  ratingCount: number | null
  reviewCount: number | null
  ratingObservedAt: string | null
  ratingSourceUrl: string | null
  symbol: string | null
  exchange: string | null
  entityId: string | null
  parentEntityId: string | null
  confidence: number
  mappingSourceUrl: string | null
  mappingRevisionId: string | null
}
interface AppStoredRow extends AppObservation {
  sourceId: string
  store: AppStore
  country: string
  chart: AppChart
  category: string
  chartLimit: number
  sourceUrl: string
  sourceUpdatedAt: string | null
  observedAt: string
  revisionId: string
  supersedesRevisionId: string | null
}
interface AppAttentionRow extends AppStoredRow {
  rankChange1d: number | null
  rankChange7d: number | null
  rankVelocity7d: number | null
  ratingChange7d: number | null
  ratingCountGrowth7d: number | null
  reviewGrowth7d: number | null
  stale: boolean
}
export interface AppCompany {
  symbol: string
  name: string
  appCount: number
  countryCount: number
  chartCount: number
  attentionScore: number | null
  rankVelocity7d: number | null
  ratingChange7d: number | null
  ratingCountGrowth7d: number | null
  comparableSeries7d: number
  observedAt: string
}
interface AppHistoryPoint {
  date: string
  attentionScore: number | null
  appCount: number
  countryCount: number
  seriesCount: number
  rating: number | null
  ratingCount: number | null
  reviewCount: number | null
}
interface AppCountry {
  country: string
  appCount: number
  rankedApps: number
  attentionScore: number | null
  rankVelocity7d: number | null
  observedAt: string
}
interface AppSourceState {
  sourceId: string
  lastAttemptAt: string | null
  lastOkAt: string | null
  nextPollAt: string | null
  failures: number
  lastError: string | null
  captures: number
}
export interface AppAttentionPayload {
  generatedAt: string
  requestedSymbol?: string
  page?: { offset: number; limit: number; total: number; nextOffset: number | null }
  symbol: string | null
  access: "pro" | "preview"
  status: "ready" | "collecting" | "unavailable"
  summary: {
    appCount: number
    companyCount: number
    countryCount: number
    observationCount: number
    mappedObservationCount: number
    attentionScore: number | null
    rankVelocity7d: number | null
    ratingChange7d: number | null
    ratingCountGrowth7d: number | null
    comparableSeries7d: number
    firstObservedAt: string | null
    lastObservedAt: string | null
  }
  apps: AppAttentionRow[]
  companies: AppCompany[]
  peers: AppCompany[]
  countries: AppCountry[]
  history: AppHistoryPoint[]
  spreads: Array<{ appId: string; name: string; chart: AppChart; category: string; bestCountry: string; bestRank: number; worstCountry: string; worstRank: number; spread: number; countryCount: number }>
  evidence: Array<{ revisionId: string; supersedesRevisionId: string | null; sourceId: string; sourceUrl: string; observedAt: string; sourceUpdatedAt: string | null; appId: string; name: string; country: string; chart: AppChart; rank: number | null; rating: number | null; ratingCount: number | null; reviewCount: number | null; ratingSourceUrl: string | null; mappingSourceUrl: string | null; confidence: number }>
  coverage: {
    configuredCountries: string[]
    observedCountries: string[]
    availableCharts: AppChart[]
    categories: string[]
    sources: AppSourceState[]
    limitations: string[]
    historyDays: number
    staleAfterHours: number
  }
  locked: { apps: number; companies: number; peers: number; countries: number; history: number; spreads: number; evidence: number }
}

export interface AppRankPayload {
  generatedAt: string;
  access: "pro" | "preview";
  status: "ready" | "collecting";
  store: AppStore;
  appId: string;
  rankHistory: Array<{ appId: string; name: string; store: AppStore; country: string; chart: AppChart; category: string; date: string; rank: number | null; rating: number | null; ratingCount: number | null; reviewCount: number | null; observedAt: string; sourceUpdatedAt: string | null; ratingSourceUrl: string | null; present: boolean; sourceUrl: string; revisionId: string; chartLimit: number }>;
  page: { offset: number; limit: number; total: number; nextOffset: number | null };
  locked: number;
}
