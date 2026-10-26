/** The CFTC report: Legacy, Disaggregated, or Traders in Financial Futures (TFF). */
export type CotFamily = "legacy" | "disaggregated" | "tff"
export type CotClass = "noncommercial" | "commercial" | "producer" | "swap" | "managed-money" | "other-reportable" | "nonreportable"
  | "dealer" | "asset-manager" | "leveraged-funds"
/** Futures positions alone, or futures and options combined (options delta-adjusted, as the CFTC reports them). */
export type CotPositions = "futures-only" | "combined"
interface CotPosition { long: number | null; short: number | null; spreading: number | null }
interface CotPercentile {
  value: number | null
  rank: number | null
  sampleCount: number
  windowStart: string
  windowEnd: string
  historyStart: string | null
  historyEnd: string | null
  completeWindow: boolean
  min: number | null
  max: number | null
  mean: number | null
}
export interface CotClassSummary extends CotPosition {
  id: CotClass
  label: string
  net: number | null
  netPercentOfOpenInterest: number | null
  weeklyChange: number | null
  previousReportDate: string | null
  percentile1Y: CotPercentile
  percentile3Y: CotPercentile
}
interface CotMarket {
  contractCode: string
  marketName: string
  exchangeCode: string
  commodityCode: string
  /** What one contract is, in the CFTC's words: "CONTRACTS OF 100 TROY OUNCES". Null where the report states none. */
  contractUnits?: string | null
}
export interface CotPayloadBase {
  source: "CFTC"
  scope: CotPositions
  reportFamily: CotFamily
  generatedAt: string
  /** Tuesday position observation date, distinct from publication/download time. */
  asOf: string | null
  /** Latest report's actual source download time, not its publication time. */
  fetchedAt: string | null
  /** These files do not establish the report's actual publication timestamp. */
  publishedAt: null
  status: "available" | "partial" | "unavailable"
  gaps: string[]
  classes: Array<{ id: CotClass; label: string }>
}
export interface CotBoardRow extends CotMarket {
  reportDate: string
  openInterest: number | null
  position: CotClassSummary
  status: "available" | "stale" | "unavailable"
}
export interface CotBoardPayload extends CotPayloadBase {
  traderClass: CotClass
  /** All markets in the latest report, ranked by distance from median 1Y net. */
  rows: CotBoardRow[]
}
export interface CotHistoryPoint {
  reportDate: string
  openInterest: number | null
  positions: Array<CotPosition & { id: CotClass; net: number | null; netPercentOfOpenInterest: number | null }>
}
export interface CotContractPayload extends CotPayloadBase {
  contract: CotMarket | null
  sourceUrl: string | null
  openInterest: number | null
  /** Latest report's classes, each with 1Y and 3Y dated distribution context. */
  positions: CotClassSummary[]
  /** Oldest first. Missing/suppressed legs and corresponding net remain null. */
  history: CotHistoryPoint[]
}
