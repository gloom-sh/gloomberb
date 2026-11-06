import type { DataTableColumn } from "../../../components";
import type { SelectButtonOption } from "../../../components/ui/select-button";
import type { SocialOutlierRow, SocialOutlierWindow } from "../../../api-client/social-mentions";
import { formatShortDate } from "../../../utils/datetime-format";
import { displayWidth, formatPercentRaw } from "../../../utils/format";
import type { SortComparableValue } from "../../../utils/sort-values";
import { MARKET_CAP_BAND_OPTIONS } from "../shared/market-cap-bands";
import { NO_VALUE } from "../shared/research-cells";
import { DEFAULT_SOCIAL_OUTLIERS_QUERY, type SocialOutliersQuery } from "./outliers-client";
import { socialCount, socialRatio, socialStance } from "./model";

/** BUZZ alone: its title, and the one it goes back to from a ticker. */
export const SOCIAL_OUTLIERS_TITLE = "Social Outliers";

export const SOCIAL_OUTLIER_WINDOW_OPTIONS: SelectButtonOption<SocialOutlierWindow>[] = [
  { value: "day", label: "Latest day", description: "Each ticker's latest closed UTC day" },
  { value: "today", label: "Today", description: "Today's posts so far, UTC" },
];

export const SOCIAL_OUTLIER_MIN_OPTIONS: SelectButtonOption[] = [
  { value: "0", label: "Any" },
  { value: "25", label: "25+" },
  { value: "100", label: "100+" },
  { value: "500", label: "500+" },
  { value: "1000", label: "1,000+" },
];

export const SOCIAL_OUTLIER_CAP_OPTIONS = MARKET_CAP_BAND_OPTIONS;

const optionValue = <T extends string>(options: readonly SelectButtonOption<T>[], value: unknown, fallback: T): T =>
  options.some((option) => option.value === value) ? value as T : fallback;

/** A query from what the pane stored, each part checked and defaulted on its own. */
export function socialOutliersQueryFrom(stored: { window?: unknown; minPosts?: unknown; cap?: unknown }): SocialOutliersQuery {
  const cap = optionValue(SOCIAL_OUTLIER_CAP_OPTIONS, stored.cap, "all");
  return {
    window: optionValue(SOCIAL_OUTLIER_WINDOW_OPTIONS, stored.window, DEFAULT_SOCIAL_OUTLIERS_QUERY.window),
    minPosts: minPostsFrom(stored.minPosts),
    cap: cap === "all" ? null : cap,
  };
}

/** The server's ceiling on a minimum. */
const MAX_MIN_POSTS = 1_000_000;

/** Any whole count the CLI can set (`--min-posts 50`), not only the menu's. */
function minPostsFrom(stored: unknown): number {
  const value = typeof stored === "string" && stored.trim() ? Number(stored) : stored;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_MIN_POSTS
    ? value
    : DEFAULT_SOCIAL_OUTLIERS_QUERY.minPosts;
}

/** The menu's minimums, with one the CLI set in its place among them. */
export function socialOutlierMinOptions(minPosts: number): SelectButtonOption[] {
  if (SOCIAL_OUTLIER_MIN_OPTIONS.some((option) => option.value === String(minPosts))) return SOCIAL_OUTLIER_MIN_OPTIONS;
  return [...SOCIAL_OUTLIER_MIN_OPTIONS, { value: String(minPosts), label: `${socialCount(minPosts)}+` }]
    .sort((a, b) => Number(a.value) - Number(b.value));
}

export type SocialOutlierColumnId = "ticker" | "company" | "day" | "countedAt" | "mentions" | "baseline" | "ratio" | "stance" | "price";
export interface SocialOutlierColumn extends DataTableColumn {
  id: SocialOutlierColumnId;
}

/** The ranked day as the ticker's own table dates it. */
export const outlierDay = (row: Pick<SocialOutlierRow, "day">) => row.day;
/** When today's count was read: the column header says UTC. */
export const outlierCountedAt = (row: Pick<SocialOutlierRow, "countedAt">) => {
  const time = new Date(row.countedAt);
  return Number.isNaN(time.getTime()) ? NO_VALUE : `${time.toISOString().slice(11, 16)} UTC`;
};
export const outlierPrice = (row: Pick<SocialOutlierRow, "price">) => row.price ? formatPercentRaw(row.price.changePct) : NO_VALUE;

/** Cells left and right of the columns, and between two of them. */
const TABLE_PADDING = 2;
const COLUMN_GAP = 1;
/** The kit widens a column to fit its header plus the sort arrow. */
const HEADER_EXTRA = 2;
/** Below this the company names read as stubs: the column goes instead. */
const COMPANY_MIN = 12;

function fitWidth(texts: readonly string[], label: string, max: number): number {
  const widest = texts.reduce((width, value) => Math.max(width, displayWidth(value)), 0);
  return Math.max(displayWidth(label) + HEADER_EXTRA, Math.min(max, widest));
}

/** What a narrow pane gives up, first to last: the median the multiple already measures against, then the company. */
const NARROW_DROPS = ["baseline", "company", "stance"] as const;

/**
 * The columns that fit `width` cells: the ticker and company, the day
 * counted (today: when it was read), the posts, the 30-day median, the
 * multiple, the stance and the price move. The company takes the room left.
 */
export function buildSocialOutlierColumns(width: number, rows: readonly SocialOutlierRow[], window: SocialOutlierWindow): SocialOutlierColumn[] {
  const widths = {
    ticker: fitWidth(rows.map((row) => row.symbol), "Ticker", 8),
    when: window === "today" ? fitWidth(rows.map(outlierCountedAt), "As of", 9) : fitWidth(rows.map(outlierDay), "Date", 10),
    mentions: fitWidth(rows.map((row) => socialCount(row.mentions)), "Posts", 9),
    baseline: fitWidth(rows.map((row) => socialCount(row.baseline)), "30D median", 9),
    ratio: fitWidth(rows.map((row) => socialRatio(row.ratio)), "Vs median", 7),
    stance: fitWidth(rows.map((row) => socialStance(row.stance)), "Stance", 6),
    price: fitWidth(rows.map(outlierPrice), "Price %", 9),
  };
  const show = { baseline: true, company: true, stance: true };
  const available = Math.max(0, Math.floor(width) - TABLE_PADDING);
  const fixed = () => [widths.ticker, widths.when, widths.mentions, show.baseline ? widths.baseline : 0, widths.ratio,
    show.stance ? widths.stance : 0, widths.price].reduce((sum, columnWidth) => sum + (columnWidth > 0 ? columnWidth + COLUMN_GAP : 0), 0) - COLUMN_GAP;
  const room = () => available - fixed() - (show.company ? COLUMN_GAP : 0);
  for (const drop of NARROW_DROPS) {
    if (room() >= (show.company ? COMPANY_MIN : 0)) break;
    show[drop] = false;
  }
  return [
    { id: "ticker", label: "Ticker", width: widths.ticker, align: "left" },
    ...(show.company ? [{ id: "company" as const, label: "Company", width: Math.max(COMPANY_MIN, room()), align: "left" as const, flexGrow: 1 }] : []),
    window === "today"
      ? { id: "countedAt", label: "As of", width: widths.when, align: "right" }
      : { id: "day", label: "Date", width: widths.when, align: "left" },
    { id: "mentions", label: "Posts", width: widths.mentions, align: "right" },
    ...(show.baseline ? [{ id: "baseline" as const, label: "30D median", width: widths.baseline, align: "right" as const }] : []),
    { id: "ratio", label: "Vs median", width: widths.ratio, align: "right", ...(show.company ? {} : { flexGrow: 1 }) },
    ...(show.stance ? [{ id: "stance" as const, label: "Stance", width: widths.stance, align: "right" as const }] : []),
    { id: "price", label: "Price %", width: widths.price, align: "right" },
  ];
}

/** What a column sorts a row by: a missing value sorts last either way, the ranking's order breaks ties. */
export function socialOutlierSortValue(row: SocialOutlierRow, columnId: SocialOutlierColumnId): SortComparableValue {
  switch (columnId) {
    case "ticker": return row.symbol;
    case "company": return row.name?.toLocaleLowerCase("en-US") ?? null;
    case "day": return row.day;
    case "countedAt": return row.countedAt;
    case "mentions": return row.mentions;
    case "baseline": return row.baseline;
    case "ratio": return row.ratio;
    case "stance": return row.stance;
    case "price": return row.price?.changePct ?? null;
  }
}

/** Names sort A to Z first, figures and dates largest first. */
export function socialOutlierFirstDirection(columnId: SocialOutlierColumnId): "asc" | "desc" {
  return columnId === "ticker" || columnId === "company" ? "asc" : "desc";
}

/** Whether a query narrows the window it reads. */
export function socialOutliersFiltered(query: SocialOutliersQuery): boolean {
  return query.minPosts > 0 || query.cap !== null;
}

export function socialOutliersEmptyTitle(window: SocialOutlierWindow, freshFrom: string, filtered: boolean): string {
  const since = window === "today" ? "today" : `since ${formatShortDate(freshFrom, { utc: true })}`;
  return filtered ? `No ticker counted ${since} matches these filters.` : `No ticker has been counted ${since}.`;
}

/** The opened ticker's title: its symbol and company, said once. */
export function socialOutlierDetailTitle(row: Pick<SocialOutlierRow, "symbol" | "name">): string {
  return row.name ? `${row.symbol} \u00b7 ${row.name}` : row.symbol;
}
