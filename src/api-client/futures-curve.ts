/** What one contract of a root is, from the exchange's rulebook. */
export interface FuturesContractSpec {
  /** What a quoted price counts: "USD / troy oz", "US cents / bushel", "index points". */
  unit: string
  /** One contract as the exchange words it: "100 troy oz", "$50 x index". */
  size: string
  /** US dollars a move of 1.0 in the quoted price makes on one contract. */
  pointValue: number
  /** The smallest outright price move, in the quoted unit. */
  tick: number
  /** US dollars one tick makes on one contract. */
  tickValue: number
  settlement: "physical" | "cash"
}

/** What a futures symbol trades: the contract behind it, its terms and its latest confirmed settlement. */
export interface FuturesContractTermsPayload {
  /** The symbol asked for: GC=F, GCZ26 or CL1. */
  symbol: string
  root: string
  name: string
  /** The listed contract the symbol prices today (GCZ26 for GC=F); null where it cannot be placed. */
  contract: string | null
  contractSymbol: string | null
  deliveryMonth: string | null
  spec: FuturesContractSpec | null
  lastTrade: string | null
  firstNotice: string | null
  /** Past first notice: a long can be assigned delivery. */
  inDelivery: boolean
  /** The newest exchange settlement confirmed for the contract, with its session. */
  settlement: { price: number; date: string } | null
  /**
   * For a continuous symbol (CL=F) or a front generic: the nearest contract
   * still trading once the symbol has rolled past it on its roll date, with
   * its last trade; null when it prices the nearest itself. Absent from
   * servers that do not send it.
   */
  nearest?: FuturesNearestContract | null
  /**
   * For a continuous symbol or a generic: how it rolls ("1 day before last
   * trade") and the first session it is on the next contract; the date is
   * null under the open interest switch. Absent from older servers.
   */
  roll?: { label: string; date: string | null } | null
  /**
   * The root's front contract (what its continuous symbol and first generic
   * price) when the symbol prices another one (NGF27, NG2); null on the front.
   */
  front?: FuturesNearestContract | null
  /** The contract that traded the most on the root's newest session with volumes: the day's volume alone. */
  mostActive?: FuturesMostActiveContract | null
}

/** A listed contract by its code, as the quote endpoints take it (CLX26.NYM), and its last trade. */
interface FuturesNearestContract {
  contract: string
  contractSymbol: string
  /** YYYY-MM */
  deliveryMonth: string
  lastTrade: string | null
}

/** The most active contract: its volume on that session (`date`). */
interface FuturesMostActiveContract {
  contract: string
  contractSymbol: string
  /** YYYY-MM */
  deliveryMonth: string
  volume: number
  date: string
}

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
  /**
   * The exchange settlement for the curve's settlementDate; null when none is
   * confirmed for that session. `price` is the latest trade, never a settlement,
   * except on a Cboe curve, whose prices are settlements.
   */
  settlement?: number | null
  /** The last trading day. */
  lastTrade?: string | null
  /** First notice day of a physically delivered contract; null where there is none. */
  firstNotice?: string | null
  /** Past first notice: a long can be assigned delivery. */
  inDelivery?: boolean
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
    /**
     * What the spread subtracts: two last trades made at the same time
     * ("last"), or both contracts' settlements for the session in `asOf`
     * ("settle"). Absent from a server that does not say.
     */
    basis?: "last" | "settle" | null
    /** The leg that makes the spread thin (state "thin"): too few lots this session, or no trade in it. */
    thinSymbol?: string | null
    state: "contango" | "backwardation" | "flat" | "thin" | "unavailable"
  }
  gaps: string[]
  /** The session the contracts' settlements are for; null when none is confirmed. */
  settlementDate?: string | null
  /** The root's contract terms; null where they are not listed. */
  spec?: FuturesContractSpec | null
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
    /** The price is the exchange settlement for tradeDate; otherwise that session's last trade or, when stale, an earlier price. */
    settled?: boolean
    lastTrade?: string | null
    firstNotice?: string | null
    inDelivery?: boolean
  }>
  gaps: string[]
  spec?: FuturesContractSpec | null
}
