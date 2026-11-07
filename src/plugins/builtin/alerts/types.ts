import type { QuoteDataSource } from "../../../types/financials";
import type { QuoteChangeBasis } from "../../../market-data/market/change-basis";

export type AlertCondition = "above" | "below" | "crosses";
export type AlertStatus = "active" | "triggered" | "expired";

export interface AlertRule {
  id: string;
  symbol: string;
  exchange?: string;
  condition: AlertCondition;
  targetPrice: number;
  metric?: import("./metric-model").AlertMetric;
  /**
   * A move from the previous close rather than a price level: `targetPrice` is
   * the move in percent, `above` a rise, `below` a fall and `crosses` either.
   * Kept in its own synced list (`MOVE_ALERTS_KEY`).
   */
  move?: boolean;
  /** The session a move rule last went off in (the close it was measured from); it arms again in the next one. */
  moveSession?: string;
  /**
   * The latest session a move rule went off in on a device, as its quote dates
   * the move (changeSessionDate). Kept in the synced rule, so Gloom Cloud never
   * pushes or emails a session the app already alerted on.
   */
  moveDay?: string;
  /**
   * Written on every synced move rule by an app that syncs `moveDay`. Gloom
   * Cloud judges only rules that carry it: an older app alerts on its own and
   * syncs nothing of it, and drops the field when it rewrites the list.
   */
  syncsMoveDay?: true;
  /** What the last move read was measured from, as its quote's change line names it. */
  lastMoveBasis?: QuoteChangeBasis;
  lastDailyClose?: string;
  lastCheckedTarget?: number;
  createdAt: number;
  /** When an edit or re-arm last armed the rule; createdAt until then. Gloom Cloud emails a trigger once per arming. */
  armedAt?: number;
  status: AlertStatus;
  triggeredAt?: number;
  lastCheckedPrice?: number;
  lastCheckedAt?: number;
  lastCheckError?: string;
  lastQuoteUpdatedAt?: number;
  lastQuoteSource?: QuoteDataSource;
  lastQuoteProviderId?: string;
  /** The currency of the quote the alert was last checked on (USD): its listing's, which lists show beside it. */
  lastQuoteCurrency?: string;
  /** The venue that quote was from (ARCA), which names the listing of a rule set by symbol alone. */
  lastQuoteExchange?: string;
  /** That quote was of a London line in pence (117.35p), whose levels are written in pence. */
  lastQuotePence?: boolean;
  message?: string;
}
