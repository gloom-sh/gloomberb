/** Stored thematic baskets served by /cloud/themes and /cloud/themes/:id. */
export const THEME_PERIODS = ["changePercent", "return1WPercent", "return1MPercent", "return3MPercent", "returnYtdPercent"] as const;
export type ThemePeriod = typeof THEME_PERIODS[number];
export interface ThemeAggregate { value: number | null; covered: number; total: number }
export interface ThemeSummary {
  id: string;
  name: string;
  description: string;
  keywords: readonly string[];
  memberCount: number;
  present: number;
  returns: Record<ThemePeriod, ThemeAggregate>;
  breadth: ThemeAggregate;
  best: { symbol: string; changePercent: number } | null;
  worst: { symbol: string; changePercent: number } | null;
  stale: boolean;
}
/**
 * A member's figures. `price`, `changePercent` and the returns are the regular
 * session's: outside it, its close and that close's move. The extended fields
 * are the pre-market or after-hours print measured from that close; a server
 * sends them only when there is one, and older servers never do.
 */
export interface ThemeMember extends Record<ThemePeriod | "price", number | null> {
  symbol: string;
  name: string | null;
  exchange: string | null;
  present: boolean;
  asOf: Record<ThemePeriod | "price", string | null>;
  stale: boolean;
  extendedSession?: "PRE" | "POST" | null;
  extendedPrice?: number | null;
  extendedChange?: number | null;
  extendedChangePercent?: number | null;
}
interface SnapshotMetadata {
  /** When the server put the snapshot together, not a trade time. */
  asOf: string;
  snapshotId: string;
  stale: boolean;
  /**
   * Whose prices the board carries: `realtime` for a Pro account, priced from
   * a live read the server renews every 15 seconds; `delayed`, fifteen
   * minutes behind, otherwise. An older server leaves it out (delayed).
   */
  access?: "realtime" | "delayed";
  /** The US market as the board reads it: now for a real-time board, fifteen minutes back otherwise. Absent from older servers. */
  session?: "PRE" | "REGULAR" | "POST" | "CLOSED" | null;
  /** Outside the regular session, the completed session every figure describes; null while one trades. */
  regularSessionDate?: string | null;
  /** When that session closed, in epoch milliseconds (13:00 New York on an early close). */
  regularSessionClosedAt?: number | null;
}
export interface ThemesPayload extends SnapshotMetadata { themes: ThemeSummary[] }
export interface ThemeMembersPayload extends SnapshotMetadata { theme: ThemeSummary; members: ThemeMember[] }
