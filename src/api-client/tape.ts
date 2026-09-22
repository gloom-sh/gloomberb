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
  /** Alpaca quote sizes are round lots. */
  bidSize: number;
  askSize: number;
  bidExchange: string;
  askExchange: string;
  conditions: string[];
  tape: string;
}
export interface TapeSnapshot {
  source: "Alpaca";
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
}
export type TapeFeedEvent = { type: "data"; payload: TapeSnapshot }
  | { type: "reset" | "disconnected"; reason: string };
