import type { ManualChartResolution } from "../time-series/resolution";
import type { PricePoint } from "./financials";

/** Declared by the actual history source, independently of quote session state. */
export interface HistorySession {
  version: 1;
  kind: "regular";
  calendar: "us-equity";
  timeZone: "America/New_York";
  symbol: string;
  exchange: string;
  interval: string;
  source: "yahoo" | "twelvedata" | "alpaca";
  timestampConvention: "bar-open" | "bar-open-with-final-observation";
  barAlignment: "session-open" | "clock";
  /** Actual acquisition time, retained unchanged through source/cache projections. */
  observedAt: number;
}

/** Serializable history acquisition; bare-array methods remain compatibility projections. */
export interface PriceHistoryResult {
  points: PricePoint[];
  resolution: ManualChartResolution | null;
  session?: HistorySession;
  /** Router-selected provider or broker, never its preferred/default source. */
  sourceKey?: string;
}
