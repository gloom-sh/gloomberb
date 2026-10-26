const ASSET_CLASSES = ["stocks", "indices", "energy", "metals", "fx", "crypto", "other"] as const
type AssetClass = (typeof ASSET_CLASSES)[number]
type PerpVenue = "hyperliquid" | "binance" | "bybit" | "okx" | "deribit" | "coinbase" | "kraken" | "dydx"

/** Rates and premiums are fractions, timestamps UTC; null always means unavailable. */
interface PerpMarket {
  marketId: string
  venue: PerpVenue
  dex: string
  symbol: string
  baseAsset: string
  displayName: string
  assetClass: AssetClass
  underlyingSymbol: string | null
  underlyingCurrency: string | null
  quoteCurrency: string
  marginCurrency: string
  contractType: "linear" | "inverse" | "quanto"
  priceMultiplier: number
  markPrice: number | null
  oraclePrice: number | null
  lastPrice: number | null
  previousDayPrice: number | null
  priceChange24h: number | null
  premium: number | null
  venuePremium: number | null
  fundingRate: number | null
  fundingIntervalHours: number | null
  fundingKind: "current" | "last-paid" | "continuous"
  fundingRate8h: number | null
  fundingApr: number | null
  predictedFundingRate: number | null
  predictedFundingIntervalHours: number | null
  nextFundingAt: string | null
  openInterestBase: number | null
  openInterestUsd: number | null
  volume24hUsd: number | null
  maxLeverage: number | null
  isolatedOnly: boolean | null
  delisted: boolean
  observedAt: string
  sourceAsOf: string | null
  sourceUrl: string
  confidence: "high" | "medium" | "low"
  qualityFlags: string[]
}

interface PerpFunding {
  marketId: string
  time: string
  rate: number
  intervalHours: number
  premium: number | null
  observedAt: string
  sourceUrl: string
}

interface PerpCandle {
  marketId: string
  time: string
  interval: "1h"
  open: number
  high: number
  low: number
  close: number
  volumeBase: number | null
  trades: number | null
  observedAt: string
  sourceUrl: string
}

interface UnderlyingReference {
  symbol: string
  listingExchange?: string
  price: number
  currency: string
  asOf: string
  marketState: string | null
  sourceUrl: string
}

/**
 * The venue's latest long/short account reading for one contract, in its own hourly bucket. Shares are
 * fractions and may sum to less than one (flat accounts); OKX publishes only the ratio, so its shares are derived.
 */
export interface PerpLongShortRatio {
  venue: string
  /** Key of what is counted, such as `accounts_all`; `definitionText` says it in words. */
  definition: string
  definitionText: string
  period: string
  longShare: number
  shortShare: number
  ratio: number | null
  derived: boolean
  bucketAt: string
  observedAt: string
  /** The bucket is more than three hours old. */
  stale: boolean
}
/** Why a row has no reading: the venue publishes none, collection is off, or nothing is stored yet. */
type PerpLongShortReason = "unsupported" | "off" | "collecting"

export interface PerpBoardRow extends PerpMarket {
  equityMatch?: { listing: PerpEquityListing; underlying: PerpEquityListing; basis: "listing" | "issuer" }
  stale: boolean
  oiChange1h: number | null
  oiChange24h: number | null
  oiUsdChange1h: number | null
  oiUsdChange24h: number | null
  underlying: UnderlyingReference | null
  underlyingPremium: number | null
  closedMarketPremium: number | null
  /** Absent from servers older than the long/short series: read as null. */
  longShortRatio?: PerpLongShortRatio | null
  longShortRatioReason?: PerpLongShortReason | null
}

export type PerpLongShortPoint = {
  time: string
  definition: string
  longShare: number
  shortShare: number
  ratio: number | null
  derived: boolean
  observedAt: string
}

type PerpHistoryPoint = {
  time: string
  resolution: "minute" | "hour" | "day"
  markPrice: number | null
  oraclePrice: number | null
  premium: number | null
  fundingRate: number | null
  fundingIntervalHours: number | null
  openInterestBase: number | null
  openInterestUsd: number | null
  sampleCount: number
  firstObservedAt: string
  lastObservedAt: string
}

export interface PerpBoardPayload {
  listing?: PerpEquityListing | null;
  status: string; asOf: string | null; rows: PerpBoardRow[]; total: number; locked: number;
  access: "pro" | "preview"; sources?: unknown[];
}
export interface PerpEquityListing { symbol: string; exchange: string }
/**
 * The batch lookup a watchlist or portfolio makes: one entry per requested listing, in its order, with the contract
 * the single equity lookup would list first, or none. `listing` is null when the server cannot read the listing.
 */
export interface PerpEquitiesPayload {
  status: string; asOf: string | null; access: "pro" | "preview"; locked: number;
  results: { listing: PerpEquityListing | null; market: PerpBoardRow | null }[];
}
export interface PerpHistoryPayload {
  status: string; marketId: string; rows: PerpHistoryPoint[]; funding: PerpFunding[]; candles: PerpCandle[];
  /** Absent from servers older than the long/short series: read as empty. */
  longShortRatio?: PerpLongShortPoint[];
  locked: boolean; access: "pro" | "preview"; asOf: string | null;
  from?: string; to?: string; resolution?: "minute" | "hour" | "day"; truncated?: boolean;
}
export interface PerpRankingsPayload {
  status: string; asOf: string | null; access: "pro" | "preview"; locked: boolean;
  fundingPositive: PerpBoardRow[]; fundingNegative: PerpBoardRow[]; oiSurges: PerpBoardRow[];
  premiumDislocations: PerpBoardRow[]; closedMarketDislocations: PerpBoardRow[];
}
export type PerpBoardQuery = { assetClass?: string; search?: string; sort?: string; includeDelisted?: boolean };
export type PerpHistoryQuery = { marketId: string; from?: string; to?: string; resolution?: "auto" | "minute" | "hour" | "day"; limit?: number };

export interface PerpMarketPayload extends PerpBoardPayload {
  evidence: { kind: string; period_at: string; received_at: string; superseded_at: string | null; fingerprint: string; payload: PerpMarket | PerpFunding | PerpCandle }[];
  methodologyUrl: string;
}

/** One contract's liquidations: long is longs liquidated (forced sells), short is shorts; quote notional. */
export interface PerpLiquidationMarket {
  marketId: string; venue: string; symbol: string; dex: string; quoteCurrency: string;
  long24h: number; short24h: number; long7d: number; short7d: number; count24h: number; count7d: number; lastEventAt: string | null;
}
export interface PerpLiquidationPrint {
  marketId: string; venue: string; symbol: string; dex: string;
  side: "long" | "short"; priceKind: "fill" | "bankruptcy"; price: number; quantity: number; notionalUsd: number;
  /** The venue's time for the liquidation. */
  eventAt: string;
  /** When Gloom Cloud received it. */
  receivedAt: string;
}
/** One base asset's liquidations across the venues' public streams. */
export interface PerpLiquidationsPayload {
  status: string; baseAsset: string; asOf: string; from: string; collectingSince: string | null;
  markets: PerpLiquidationMarket[];
  totals: Pick<PerpLiquidationMarket, "long24h" | "short24h" | "long7d" | "short7d" | "count24h" | "count7d">;
  /** Pro: UTC hours with liquidations over the last 7 days; empty for a preview. */
  hourly: { time: string; long: number; short: number; count: number }[];
  largest: PerpLiquidationPrint[];
  streams: { venue: string; state: "live" | "down"; lastOkAt: string | null; error: string | null }[];
  notes: string[];
  locked: boolean; access: "pro" | "preview";
}
/** Quote notional resting within 0.5%, 1% and 2% of mid; reach is how far the returned book went, as a fraction of mid. */
export interface PerpDepthSnapshot {
  marketId: string; bucket: string; observedAt: string; sourceAsOf: string | null; mid: number;
  bid05: number; ask05: number; bid1: number; ask1: number; bid2: number; ask2: number;
  bidReach: number; askReach: number; levels: number; grouping: number | null;
}
export interface PerpDepthRow extends PerpDepthSnapshot { venue: string; symbol: string; dex: string; quoteCurrency: string; stale: boolean }
/** One base asset's hourly order book depth across the venues. */
export interface PerpDepthPayload {
  status: string; baseAsset: string; asOf: string;
  rows: PerpDepthRow[];
  /** Pro: every market's hourly snapshots over the last 7 days; empty for a preview. */
  history: PerpDepthSnapshot[];
  sources: { venue: string; lastOkAt: string | null; error: string | null }[];
  notes: string[];
  locked: boolean; access: "pro" | "preview";
}
