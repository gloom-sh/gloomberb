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
  source: "gloom";
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
  /** First date (YYYY-MM-DD) the source vouches for; it excluded earlier prices. */
  coverageStart?: string;
  /** Why nothing before `coverageStart` is served, when the source says: "old-shekel quotes before 1992 are not served". */
  coverageNote?: string;
  /** The source served the pre-market and after-hours bars the request asked for. */
  extendedHours?: boolean;
  /**
   * The router answered an intraday request from a saved copy that stops short
   * of the venue's latest session: a refetch failed, the app is offline or the
   * source answered bars still behind. Never stored with a copy. Absent for a
   * current copy, whatever its last bar, and for a source's own answer.
   */
  savedCopyBehind?: true;
}
