/** Gloom Cloud futures prices retain provider denomination and explicit quote units. */
export interface FuturesContract {
  symbol: string
  label: string
  expiration: string
  price: number | null
  /** Session change of `price`; absent from payloads cached before the server kept it. */
  change?: number | null
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
  source: "gloom" | "cboe"
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


/** A root's curve as Gloom Cloud's settlement archive held it on a past session. */
export interface FuturesCurveAsOfPayload {
  root: string
  name: string
  date: string
  /** The newest session among the points; null when there are none. */
  asOf: string | null
  currency: string | null
  quoteUnit: string | null
  /** The first session the archive holds for this root. */
  archiveStart: string | null
  contracts: Array<{
    contract: string
    symbol: string
    label: string
    deliveryMonth: string
    expiration: string | null
    tradeDate: string
    price: number
    volume: number | null
    openInterest: number | null
    /** When the price was made; older than tradeDate when the contract did not trade that day. */
    asOf: string
    stale: boolean
  }>
  gaps: string[]
}
