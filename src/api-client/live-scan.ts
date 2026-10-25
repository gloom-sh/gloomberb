/**
 * The live scanner's wire format: a user's own intraday conditions over a
 * universe of US stocks, evaluated by Gloom Cloud against a market-wide
 * snapshot it refreshes every few seconds (real-time for Pro, 15 minutes
 * delayed otherwise). `GET /market/scanner/live?scan=<definition JSON>`.
 */

/** Minutes a move, a volume window or an event can look back over. */
export const LIVE_SCAN_WINDOWS = [1, 5, 15, 30, 60] as const;
export type LiveScanWindow = (typeof LIVE_SCAN_WINDOWS)[number];

export const LIVE_SCAN_INDEXES = ["sp500", "sp400", "sp600", "russell1000", "russell2000"] as const;
export type LiveScanIndex = (typeof LIVE_SCAN_INDEXES)[number];

/** The universe as Gloom Cloud reads it; a watchlist goes as its symbols. */
type LiveScanWireUniverse =
  | { kind: "all" }
  | { kind: "index"; index: LiveScanIndex }
  | { kind: "sector"; sector: string }
  | { kind: "symbols"; symbols: string[] };

export type LiveScanDirection = "up" | "down" | "either";

export type LiveScanCondition =
  /** Volume over the window (or the session so far) against the 20-session average's pace. */
  | { kind: "volume_spike"; window: LiveScanWindow | "day"; ratio: number }
  /** Percent move over the last `window` minutes. */
  | { kind: "move"; window: LiveScanWindow; direction: LiveScanDirection; percent: number }
  /** A new session high (low) printed in the last `within` minutes. */
  | { kind: "new_high" | "new_low"; within: LiveScanWindow }
  /** Crossed the session VWAP in the last `within` minutes, and still on that side. */
  | { kind: "vwap_cross"; direction: "above" | "below" | "either"; within: LiveScanWindow }
  /** The session's open against the previous close. */
  | { kind: "gap"; direction: LiveScanDirection; percent: number };

export interface LiveScanWireDefinition {
  version: 1;
  universe: LiveScanWireUniverse;
  conditions: LiveScanCondition[];
  minPrice?: number;
  minMarketCap?: number;
  minVolume?: number;
}

type LiveScanStatus = "live" | "starting" | "closed" | "degraded";

export interface LiveScanMatch {
  symbol: string;
  name: string | null;
  /** Its US venue (NASDAQ, NYSE, ...), null when the screener does not list it. */
  exchange?: string | null;
  price: number;
  changePercent: number | null;
  volume: number | null;
  /** The session's volume against the 20-session average's pace so far. */
  relativeVolume: number | null;
  /** Price against the session VWAP, in percent. */
  vwapPercent: number | null;
  gapPercent: number | null;
  /**
   * The figure each condition matched on, in the definition's order: a
   * percent for a move or a gap, a multiple for a volume spike, the time of
   * the event (epoch ms) for a new high or low or a VWAP cross.
   */
  values: Array<number | null>;
  /** The latest event a condition matched on. */
  signalAt: number | null;
  /** When the price printed. */
  at: number | null;
}

export interface LiveScanPayload {
  status: LiveScanStatus;
  access: "realtime" | "delayed";
  delayMinutes: number;
  /** The market time the snapshot shows. */
  asOf: number | null;
  /** When the snapshot was refreshed. */
  takenAt: number | null;
  /** How often the snapshot refreshes. */
  refreshMs: number;
  scanned: number;
  matched: number;
  matches: LiveScanMatch[];
  /** Windows the scanner cannot measure yet after it started; a condition over one matches nothing until then. */
  warmingWindows: LiveScanWindow[];
  warnings: string[];
}

/** The scan travels in a POST body: a watchlist of 1,000 symbols would not fit a request line. */
export const LIVE_SCAN_PATH = "/market/scanner/live";
