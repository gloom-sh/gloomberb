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
export interface ThemeMember extends Record<ThemePeriod | "price", number | null> {
  symbol: string;
  name: string | null;
  exchange: string | null;
  present: boolean;
  asOf: Record<ThemePeriod | "price", string | null>;
  stale: boolean;
}
interface SnapshotMetadata { asOf: string; snapshotId: string; stale: boolean }
export interface ThemesPayload extends SnapshotMetadata { themes: ThemeSummary[] }
export interface ThemeMembersPayload extends SnapshotMetadata { theme: ThemeSummary; members: ThemeMember[] }
