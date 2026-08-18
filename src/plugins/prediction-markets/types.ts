import type { ColumnConfig } from "../../types/config";
import type { PredictionCategoryId } from "./categories";

export type PredictionVenue = "polymarket" | "kalshi";
export type PredictionVenueScope = "all" | PredictionVenue;
export type PredictionBrowseTab = "top" | "ending" | "new" | "watchlist";
export type PredictionDetailTab = "overview" | "chart" | "book" | "trades" | "rules";
export type PredictionHistoryRange = "1D" | "1W" | "1M" | "ALL";
export type PredictionVolumeUnit = "usd" | "contracts";
type PredictionSortDirection = "asc" | "desc";
export type PredictionTransportState =
  | "idle"
  | "loading"
  | "live"
  | "polling"
  | "stale"
  | "error";
export type { PredictionCategoryId };

export interface PredictionSortPreference {
  columnId: string | null;
  direction: PredictionSortDirection;
}

export interface PredictionPaneSettings {
  columnIds: string[];
  hideTabs: boolean;
  lockedVenueScope: PredictionVenueScope;
  hideHeader: boolean;
  defaultBrowseTab: PredictionBrowseTab;
}

export interface PredictionMarketSummary {
  key: string;
  venue: PredictionVenue;
  marketId: string;
  title: string;
  marketLabel: string;
  eventLabel: string;
  eventId?: string;
  eventTicker?: string;
  seriesTicker?: string;
  category?: string;
  tags?: string[];
  status: string;
  url: string;
  description: string;
  endsAt: string | null;
  updatedAt: string | null;
  yesPrice: number | null;
  noPrice: number | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  spread: number | null;
  lastTradePrice: number | null;
  volume24h: number | null;
  volume24hUnit: PredictionVolumeUnit;
  totalVolume: number | null;
  totalVolumeUnit: PredictionVolumeUnit;
  openInterest: number | null;
  openInterestUnit: PredictionVolumeUnit;
  liquidity: number | null;
  liquidityUnit: PredictionVolumeUnit;
  resolutionSource?: string;
  rulesPrimary?: string;
  rulesSecondary?: string;
  yesTokenId?: string;
  noTokenId?: string;
  conditionId?: string;
}

export interface PredictionSiblingMarket {
  key: string;
  marketId: string;
  label: string;
  yesPrice: number | null;
  volume24h: number | null;
}

export interface PredictionHistoryPoint {
  date: Date;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
}

export interface PredictionBookLevel {
  price: number;
  size: number;
}

export interface PredictionBookSnapshot {
  yesBids: PredictionBookLevel[];
  yesAsks: PredictionBookLevel[];
  noBids: PredictionBookLevel[];
  noAsks: PredictionBookLevel[];
  lastTradePrice: number | null;
}

export interface PredictionTrade {
  id: string;
  timestamp: number;
  side: "buy" | "sell";
  outcome: "yes" | "no";
  price: number;
  size: number;
}

export interface PredictionMarketDetail {
  summary: PredictionMarketSummary;
  siblings: PredictionSiblingMarket[];
  rules: string[];
  history: PredictionHistoryPoint[];
  book: PredictionBookSnapshot;
  trades: PredictionTrade[];
}

export interface PredictionOrderPreviewIntent {
  marketKey: string;
  outcome: "yes" | "no";
  side: "buy" | "sell";
  price: number;
  size: number;
}

export interface PredictionColumnDef extends ColumnConfig {
  description: string;
}

interface PredictionListRowBase {
  key: string;
  kind: "market" | "group";
  venue: PredictionVenue;
  representative: PredictionMarketSummary;
  focusMarketKey: string;
  focusMarketLabel: string;
  focusYesPrice: number | null;
  markets: PredictionMarketSummary[];
  title: string;
  marketId: string;
  marketLabel: string;
  eventLabel: string;
  category?: string;
  tags?: string[];
  status: string;
  url: string;
  description: string;
  endsAt: string | null;
  updatedAt: string | null;
  yesPrice: number | null;
  noPrice: number | null;
  spread: number | null;
  lastTradePrice: number | null;
  volume24h: number | null;
  volume24hUnit: PredictionVolumeUnit;
  totalVolume: number | null;
  totalVolumeUnit: PredictionVolumeUnit;
  openInterest: number | null;
  openInterestUnit: PredictionVolumeUnit;
  liquidity: number | null;
  liquidityUnit: PredictionVolumeUnit;
  searchText: string;
  watchMarketKeys: string[];
}

export interface PredictionSingleListRow extends PredictionListRowBase {
  kind: "market";
}

export interface PredictionGroupedListRow extends PredictionListRowBase {
  kind: "group";
  marketCount: number;
  yesPriceLow: number | null;
  yesPriceHigh: number | null;
  spreadLow: number | null;
  spreadHigh: number | null;
}

export type PredictionListRow =
  | PredictionSingleListRow
  | PredictionGroupedListRow;
