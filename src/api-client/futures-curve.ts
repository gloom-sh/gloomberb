/** Gloom Cloud futures prices retain provider denomination and explicit quote units. */
export interface FuturesContract {
  symbol: string
  label: string
  expiration: string
  price: number | null
  asOf: string | null
  currency: string
  quoteUnit: string
  volume: number | null
  openInterest: number | null
  delayMinutes: number | null
  stale: boolean
  percentile: number | null
  samples: number
  historyStart: string | null
  historyEnd: string | null
}

export interface FuturesCurvePayload {
  root: string
  name: string
  source: "yahoo" | "cboe"
  currency: string | null
  quoteUnit: string | null
  asOf: string | null
  fetchedAt: string
  status: "available" | "partial" | "unavailable"
  stale: boolean
  catalogue: { method: "provider" | "bounded-search"; complete: boolean; horizonEnd: string | null }
  contracts: FuturesContract[]
  ghosts: Array<{
    label: "1W" | "1M" | "1Y"
    requestedDate: string
    asOf: string | null
    points: Array<{ symbol: string; expiration: string; price: number | null; asOf: string | null }>
  }>
  slope: {
    frontSymbol: string | null
    nextSymbol: string | null
    value: number | null
    annualizedRollYield: number | null
    percentile: number | null
    rollPercentile: number | null
    samples: number
    historyStart: string | null
    historyEnd: string | null
    asOf: string | null
    state: "contango" | "backwardation" | "flat" | "unavailable"
  }
  gaps: string[]
}

