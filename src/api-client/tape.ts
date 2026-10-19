export interface TapeTrade {
  id: string;
  timestamp: string;
  price: number;
  size: number;
  exchange: string;
  conditions: string[];
  tape: string;
}
export interface TapeQuote {
  timestamp: string;
  bid: number | null;
  ask: number | null;
  /** Quote sizes are round lots. */
  bidSize: number;
  askSize: number;
  bidExchange: string;
  askExchange: string;
  conditions: string[];
  tape: string;
}
export interface TapeSnapshot {
  source: "Gloom Cloud";
  symbol: string;
  exchange: string;
  access: "realtime" | "delayed";
  feed: "sip" | "delayed_sip";
  delaySeconds: 0 | 900;
  status: "available" | "partial" | "unavailable";
  generatedAt: string;
  asOf: string | null;
  observedFrom: string | null;
  trades: TapeTrade[];
  quotes: TapeQuote[];
  session: { date: string | null; high: number | null; low: number | null; asOf: string | null };
  gaps: string[];
  capacity: { trades: number; quotes: number };
  dropped: { trades: number; quotes: number };
  corrections: number;
  cancels: number;
  connected: boolean;
  /**
   * Present when a window was asked for (`from`/`to`): the span served, its
   * end clipped to the feed cutoff, and whether a channel held more than its
   * capacity there, so only the first of its prints are listed. Absent from a
   * server that predates windows, which answers with the latest tape.
   */
  window?: TapeRange & { truncated: { trades: boolean; quotes: boolean } };
}
/** A span of the tape as ISO instants; `to` is exclusive. */
export interface TapeRange {
  from: string;
  to: string;
}
export type TapeFeedEvent = { type: "data"; payload: TapeSnapshot }
  | { type: "reset" | "disconnected"; reason: string };
