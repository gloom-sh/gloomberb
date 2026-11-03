/** Shared server-computed scanners fanned out to every subscriber. */
export type ScannerKind = "hilo" | "flow";

export type ScannerStatus = "live" | "starting" | "closed" | "degraded";

interface ScannerWindowCounts {
  highs: number;
  lows: number;
}

export interface ScannerHiloExtreme {
  symbol: string;
  price: number;
  volume?: number | null;
  /** Times this symbol printed a new session extreme today. */
  count: number;
  at: number;
}

/** Which entitlement tier produced the payload: free accounts get a delayed instance. */
interface ScannerAccessInfo {
  access: "realtime" | "delayed";
  /** 0 on the realtime instance, 15 on the delayed one. */
  delayMinutes: number;
}

export interface ScannerHiloPayload extends ScannerAccessInfo {
  status: ScannerStatus;
  asOf: number;
  windows: {
    s30: ScannerWindowCounts;
    m1: ScannerWindowCounts;
    m5: ScannerWindowCounts;
  };
  highs: ScannerHiloExtreme[];
  lows: ScannerHiloExtreme[];
}

export interface ScannerFlowEvent {
  id: string;
  at: number;
  underlying: string;
  contract: string;
  right: "C" | "P";
  strike: number;
  expiry: string;
  side: "ask" | "bid" | "mid" | "unknown";
  kind: "sweep" | "block" | "split" | "trade";
  size: number;
  price: number;
  premium: number;
  volume?: number | null;
  openInterest?: number | null;
  volOi?: number | null;
  iv?: number | null;
}

export interface ScannerFlowPayload extends ScannerAccessInfo {
  status: ScannerStatus;
  asOf: number;
  events: ScannerFlowEvent[];
}

/** Filters for recorded flow prints, matching the FLOW pane's own. */
export interface ScannerFlowHistoryQuery {
  /** Page before this print (newest first); omit for the latest prints. */
  before?: { at: number; id: string };
  limit?: number;
  minPremium?: number;
  right?: "C" | "P";
  kind?: "sweep" | "block";
  minVolOi?: number;
  maxExpiryDays?: number;
  /** Only these listed symbols (the pane's "mine" universe). */
  symbols?: string[];
}

export interface ScannerFlowHistoryPage {
  events: ScannerFlowEvent[];
  hasMore: boolean;
}

/**
 * Premium of a slice of the session's recorded prints by where it traded: at
 * or above the ask (bought) or at or below the bid (sold). Mid and unknown
 * prints count as neither.
 */
interface ScannerFlowSidePremium {
  callAsk: number;
  callBid: number;
  putAsk: number;
  putBid: number;
}

/** The session's prints in one time bucket, which starts at `at`. */
export interface ScannerFlowSessionBucket extends ScannerFlowSidePremium {
  at: number;
}

/** What one name printed at one expiry and strike during the session. */
export interface ScannerFlowSessionStrike extends ScannerFlowSidePremium {
  expiry: string;
  strike: number;
  /** Every call print's premium, mid and unknown included. */
  callPremium: number;
  putPremium: number;
  prints: number;
}

/** The latest session's recorded prints under the FLOW pane's filters, summed. */
export interface ScannerFlowSession {
  /** The New York date of the session; null before any print was recorded. */
  session: string | null;
  bucketMs: number;
  /** Buckets with a matching print, oldest first. */
  buckets: ScannerFlowSessionBucket[];
  /** Only when one name was asked for: most premium first. */
  strikes: ScannerFlowSessionStrike[] | null;
}

export type ScannerPayload = ScannerHiloPayload | ScannerFlowPayload;

/** What a scanner subscriber receives: data, or the entitlement refusal. */
export type ScannerFeedEvent<T extends ScannerPayload = ScannerPayload> =
  { type: "data"; payload: T } | { type: "denied"; reason: string };
