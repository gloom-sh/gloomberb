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
  price: number
  currency: string
  asOf: string
  marketState: string | null
  sourceUrl: string
}

export interface PerpBoardRow extends PerpMarket {
  stale: boolean
  oiChange1h: number | null
  oiChange24h: number | null
  oiUsdChange1h: number | null
  oiUsdChange24h: number | null
  underlying: UnderlyingReference | null
  underlyingPremium: number | null
  closedMarketPremium: number | null
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
  status: string; asOf: string | null; rows: PerpBoardRow[]; total: number; locked: number;
  access: "pro" | "preview"; sources?: unknown[];
}
export interface PerpHistoryPayload {
  status: string; marketId: string; rows: PerpHistoryPoint[]; funding: PerpFunding[]; candles: PerpCandle[];
  locked: boolean; access: "pro" | "preview"; asOf: string | null;
}
export interface PerpRankingsPayload {
  status: string; asOf: string | null; access: "pro" | "preview"; locked: boolean;
  fundingPositive: PerpBoardRow[]; fundingNegative: PerpBoardRow[]; oiSurges: PerpBoardRow[];
  premiumDislocations: PerpBoardRow[]; closedMarketDislocations: PerpBoardRow[];
}
export type PerpBoardQuery = { assetClass?: string; search?: string; sort?: string; includeDelisted?: boolean };
export type PerpHistoryQuery = { marketId: string; from?: string; to?: string; resolution?: "auto" | "minute" | "hour" | "day"; limit?: number };

export interface PerpMarketPayload extends PerpBoardPayload {
  evidence: { kind: string; period_at: string; received_at: string; superseded_at: string | null; fingerprint: string; payload: PerpMarket | PerpFunding }[];
  methodologyUrl: string;
}
