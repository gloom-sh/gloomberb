type CloudCongressTradeSide = "BUY" | "SELL" | "EXCHANGE" | "OTHER";

export interface CloudCongressTradePayload {
  id: string;
  chamber: "house" | "senate";
  filingId: string;
  docId: string;
  memberName: string;
  stateDistrict: string;
  filingDate: string;
  transactionDate: string | null;
  notificationDate: string | null;
  lagDays: number | null;
  side: CloudCongressTradeSide;
  transactionType: string;
  ticker: string | null;
  assetName: string;
  assetType: string | null;
  owner: string;
  rawOwner: string;
  amount: string;
  amountLow: number | null;
  amountHigh: number | null;
  capGainsOver200: boolean | null;
  filingStatus: string | null;
  subholdingOf: string | null;
  description: string | null;
  sourceUrl: string;
  returnSinceTx?: number | null;
  returnSinceFiling?: number | null;
  /** SPY's return over the same days as returnSinceTx, percent. */
  spyReturnSinceTx?: number | null;
  spyReturnSinceFiling?: number | null;
  /** returnSinceTx less spyReturnSinceTx, percentage points. */
  excessSinceTx?: number | null;
  excessSinceFiling?: number | null;
  returnAsOf?: string | null;
  party?: string | null;
  committees?: string[];
}

export interface CloudCongressMemberPayload {
  id: string;
  memberName: string;
  stateDistrict: string;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  exchangeCount: number;
  otherCount: number;
  estimatedLow: number | null;
  estimatedHigh: number | null;
  lastFilingDate: string | null;
  avgLagDays: number | null;
  medianReturn?: number | null;
  /** Median of the trades' excessSinceFiling. */
  medianExcessSinceFiling?: number | null;
  buyHitRate?: number | null;
  pricedTradeCount?: number;
  pricedBuyCount?: number;
  excessTradeCount?: number;
  party?: string | null;
  committees?: string[];
}

export interface CloudCongressTickerPayload {
  ticker: string;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  exchangeCount: number;
  otherCount: number;
  memberCount: number;
  memberIds: string[];
  estimatedLow: number | null;
  estimatedHigh: number | null;
  lastFilingDate: string | null;
}

export interface CloudCongressHousePayload {
  asOf: string;
  /** "all" pages both chambers' filings as one date-ordered index. */
  chamber: "house" | "senate" | "all";
  source: "house-clerk" | "senate-efd" | "congress";
  year: number;
  indexUpdatedAt: string | null;
  filingsScanned: number;
  /** Filings in the window the server could read. */
  filingsParsed?: number;
  /** Filings the source refused; the server retries them on its own schedule. */
  filingsFailed?: number;
  /** Filings left unread because the server's daily document budget is spent. */
  filingsPending?: number;
  /** Scanned Senate paper filings: listed and linked, not read. */
  filingsPaper?: number;
  /** The merged feed could not reach the Senate source; this window is House only. */
  senateUnavailable?: boolean;
  filingCount: number;
  filingOffset?: number;
  hasMore?: boolean;
  hasMoreFilings?: boolean;
  nextOffset?: number;
  nextFilingOffset?: number;
  trades: CloudCongressTradePayload[];
  members: CloudCongressMemberPayload[];
  tickers?: CloudCongressTickerPayload[];
}
