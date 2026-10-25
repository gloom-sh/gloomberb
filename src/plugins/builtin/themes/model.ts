import { THEME_PERIODS, type ThemeAggregate, type ThemeMember, type ThemePeriod, type ThemeSummary } from "../../../api-client/themes";
import type { DataTableColumn } from "../../../components";
import { dropColumnsToFit, getTableWidth } from "../../../components/ui/table-layout";
import { extendedSessionStateLabel, type ExtendedSession } from "../../../market-data/market/status";
import { yearToDateBaseLabel } from "../../../market-data/market/year-to-date";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";

const PERIOD_LABELS: Record<ThemePeriod, string> = { changePercent: "1D", return1WPercent: "1W", return1MPercent: "1M", return3MPercent: "3M", returnYtdPercent: "YTD" };

/**
 * The close a board's YTD is measured from, `31 Dec`: NYSE's last session of
 * the year before the session the board describes, as the server measures it.
 */
export function boardYtdBase(payload: { asOf?: unknown; regularSessionDate?: unknown; regularSessionClosedAt?: unknown }, now = Date.now()): string {
  const day = boardClose(payload)?.date ?? (typeof payload.asOf === "string" && /^\d{4}-\d{2}-\d{2}/.test(payload.asOf) ? payload.asOf.slice(0, 10) : new Date(now).toISOString().slice(0, 10));
  return yearToDateBaseLabel(day, "NYSE", now);
}

/**
 * A period's header. YTD names its base close, as long as `room` allows:
 * `YTD vs 31 Dec close`, `YTD vs 31 Dec`, then `YTD 31 Dec`.
 */
export function periodLabel(period: ThemePeriod, ytdBase: string | null, room = Infinity): string {
  if (period !== "returnYtdPercent" || !ytdBase) return PERIOD_LABELS[period];
  const labels = [`YTD vs ${ytdBase} close`, `YTD vs ${ytdBase}`, `YTD ${ytdBase}`];
  return labels.find((label) => label.length <= room) ?? labels.at(-1)!;
}
export interface ThemeSort { columnId: string; direction: SortDirection }
export const DEFAULT_SORT: ThemeSort = { columnId: "changePercent", direction: "desc" };
export function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  const rounded = Number(value.toFixed(2));
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}%`;
}
export function aggregateText(metric: ThemeAggregate, breadth = false): string {
  const value = breadth && metric.value !== null ? `${Math.round(metric.value)}%` : percent(metric.value);
  return `${value}${metric.covered < metric.total ? ` ${metric.covered}/${metric.total}` : ""}`;
}
export const memberPrice = (value: number | null) => value === null ? "--" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const coverageWidth = (metrics: readonly ThemeAggregate[]) => Math.max(0, ...metrics.map((metric) => metric.covered < metric.total ? `${metric.covered}/${metric.total}`.length + 1 : 0));
export function sortThemes(rows: readonly ThemeSummary[], sort: ThemeSort): ThemeSummary[] {
  const value = (row: ThemeSummary) => {
    if (sort.columnId === "name") return row.name;
    if (sort.columnId === "memberCount") return row.memberCount;
    if (sort.columnId === "breadth") return row.breadth.value;
    if (sort.columnId === "best" || sort.columnId === "worst") return row[sort.columnId]?.changePercent;
    return row.returns[sort.columnId as ThemePeriod]?.value;
  };
  return [...rows].sort((a, b) => compareSortValues(value(a), value(b), sort.direction) || a.name.localeCompare(b.name));
}
export function sortMembers(rows: readonly ThemeMember[], sort: ThemeSort): ThemeMember[] {
  const session = EXTENDED_COLUMN_SESSIONS[sort.columnId];
  const value = (row: ThemeMember) => session ? extendedMove(row, session) : row[sort.columnId as "price" | "symbol" | "name"];
  return [...rows].sort((a, b) => compareSortValues(value(a), value(b), sort.direction) || a.symbol.localeCompare(b.symbol));
}

/** A snapshot older than this reads stale, whichever session it describes. */
export const SNAPSHOT_STALE_MS = 30 * 60_000;

/**
 * The completed regular session a board describes outside the regular
 * session: its date, and its close when the server sends it. Null while a
 * session trades, and from a server that does not say, whose figures then
 * read as before.
 */
export function boardClose(payload: { regularSessionDate?: unknown; regularSessionClosedAt?: unknown }): { date: string; closedAt: number | null } | null {
  const date = payload.regularSessionDate;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) return null;
  const closedAt = payload.regularSessionClosedAt;
  return { date, closedAt: typeof closedAt === "number" && Number.isFinite(closedAt) && closedAt > 0 ? closedAt : null };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** `Fri 9 Oct close` for the US session dated 2026-10-09, named by its own day, never the reader's. */
export function closeLabel(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} close`;
}

/**
 * How current the board is, for its footer. Outside the regular session the
 * close its figures describe and how old the snapshot is, `Fri 9 Oct close ·
 * snapshot 12m ago`; while a session trades, or from a server that does not
 * name the close, whether its prices are live (a Pro account's) or delayed,
 * and the snapshot's age, which the longer returns start from. `age` is the
 * relative age (`12m ago`).
 */
export function snapshotFooterText(payload: { regularSessionDate?: unknown; regularSessionClosedAt?: unknown; access?: unknown }, age: string): string {
  const close = boardClose(payload);
  if (close) return `${closeLabel(close.date)} · snapshot ${age}`;
  return `${isLiveBoard(payload) ? "live" : "15m delayed"} · snapshot ${age}`;
}

/** Whether a board's prices are real-time: a Pro account's, priced from the server's live read. */
export function isLiveBoard(payload: { access?: unknown } | null | undefined): boolean {
  return payload?.access === "realtime";
}

/** How often a board is worth checking again: the server renews a live board's prices every 15 seconds. */
export const LIVE_BOARD_REFRESH_MS = 15_000;

/** A member's pre-market or after-hours print and its move from the close in Price, when it has a valid one. */
export function memberExtended(row: ThemeMember): { session: ExtendedSession; price: number; change: number | null; changePercent: number | null } | null {
  const session = row.extendedSession;
  const price = row.extendedPrice;
  if ((session !== "PRE" && session !== "POST") || typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  return { session, price, change: finite(row.extendedChange), changePercent: finite(row.extendedChangePercent) };
}

const EXTENDED_COLUMN_SESSIONS: Record<string, ExtendedSession | undefined> = { preMarket: "PRE", afterHours: "POST" };
/** A member's move in the extended-session column `session`, or null. */
export function extendedMove(row: ThemeMember, session: ExtendedSession): number | null {
  const extended = memberExtended(row);
  return extended?.session === session ? extended.changePercent : null;
}

/** The extended sessions some member has a print for, in the order their columns go. */
export function memberExtendedSessions(rows: readonly ThemeMember[]): ExtendedSession[] {
  return (["PRE", "POST"] as const).filter((session) => rows.some((row) => memberExtended(row)?.session === session));
}

/** Exact id/name, then words, then a subsequence. Server keywords keep new themes searchable. */
export function matchTheme(rows: readonly ThemeSummary[], input: string): ThemeSummary | null {
  const query = input.trim().toLowerCase();
  if (!query) return null;
  const exact = rows.find((row) => row.id === query || row.name.toLowerCase() === query);
  if (exact) return exact;
  const words = query.split(/\s+/);
  const candidates = rows.map((row) => {
    const labels = [row.name, ...row.keywords].map((label) => label.toLowerCase());
    const score = labels.some((label) => label === query) ? 0
      : labels.some((label) => label.startsWith(query)) ? 1
      : words.every((word) => labels.some((label) => label.includes(word))) ? 2
      : labels.some((label) => { let i = 0; for (const char of label) if (char === query[i]) i++; return i === query.length; }) ? 3 : 4;
    return { row, score };
  }).filter(({ score }) => score < 4).sort((a, b) => a.score - b.score || a.row.name.localeCompare(b.row.name));
  return candidates[0]?.row ?? null;
}

const column = (id: string, label: string, width: number, align: "left" | "right" = "right"): DataTableColumn => ({ id, label, width, align });
/** Room a header has in its column: the sort indicator takes two cells. */
const HEADER_ROOM = 2;
/**
 * Drop leaders/laggards first, then longer windows; keep the day's move and
 * breadth. YTD names `ytdBase`, the close it is measured from, as fully as
 * its column allows.
 */
export function themeColumns(width: number, rows: readonly ThemeSummary[], ytdBase: string | null = null): DataTableColumn[] {
  const suffixWidth = (period: ThemePeriod) => coverageWidth(rows.map((row) => row.returns[period]));
  const metricWidth = (period: ThemePeriod) => Math.max(8, ...rows.map((row) => percent(row.returns[period].value).length)) + suffixWidth(period);
  // The same trailing space is reserved in every cell and its header. A note
  // occupies that space without moving the number away from its label.
  const label = (period: ThemePeriod, room?: number) => periodLabel(period, ytdBase, room) + " ".repeat(suffixWidth(period));
  const columns = [column("name", "Theme", 26, "left"), column("memberCount", "N", 3),
    ...THEME_PERIODS.map((period) => column(period, label(period, 0), Math.max(metricWidth(period), label(period, 0).length + HEADER_ROOM))),
    column("breadth", "Breadth" + " ".repeat(coverageWidth(rows.map((row) => row.breadth))), 7 + coverageWidth(rows.map((row) => row.breadth))),
    column("best", "Best 1D", 15), column("worst", "Worst 1D", 15)];
  const fitted = fitColumns(columns, width, ["worst", "best", "return3MPercent", "returnYtdPercent", "return1MPercent", "return1WPercent", "memberCount"]);
  const ytd = fitted.find((col) => col.id === "returnYtdPercent");
  if (ytd) ytd.label = label("returnYtdPercent", ytd.width - HEADER_ROOM - suffixWidth("returnYtdPercent"));
  return fitted;
}
/**
 * The member table at `width`. Price and 1D are the regular session's; a
 * PRE-MKT or AFTER-HRS column, named as BI and MOST name it, follows 1D for
 * each session in `extendedSessions`. A narrow pane gives up the longer
 * windows first, then that column, then the name.
 */
export function memberColumns(width: number, extendedSessions: readonly ExtendedSession[] = [], ytdBase: string | null = null): DataTableColumn[] {
  const extended = extendedSessions.map((session) => column(session === "PRE" ? "preMarket" : "afterHours", extendedSessionStateLabel(session), 9));
  const [day, ...windows] = THEME_PERIODS.map((period) => column(period, periodLabel(period, ytdBase, 0), Math.max(9, periodLabel(period, ytdBase, 0).length + HEADER_ROOM)));
  const fitted = fitColumns([column("symbol", "Ticker", 7, "left"), column("name", "Name", 24, "left"), column("price", "Price $", 10),
    day!, ...extended, ...windows], width,
  ["return3MPercent", "returnYtdPercent", "return1MPercent", "return1WPercent", "preMarket", "afterHours", "name", "price"]);
  const ytd = fitted.find((col) => col.id === "returnYtdPercent");
  if (ytd) ytd.label = periodLabel("returnYtdPercent", ytdBase, ytd.width - HEADER_ROOM);
  return fitted;
}
function fitColumns(columns: DataTableColumn[], width: number, drop: string[]): DataTableColumn[] {
  columns = dropColumnsToFit(columns, width, drop);
  const used = () => getTableWidth(columns);
  const name = columns.find((col) => col.id === "name") ?? columns[0]!;
  const spare = width - used();
  name.width = Math.max(8, name.width + Math.min(spare, Math.max(0, 36 - name.width)));
  name.flexGrow = 1;
  // Wide boards share room across the figures instead of separating every name
  // from its daily move with an almost pane-wide blank name column.
  const figures = columns.filter((col) => col.align === "right" && col.id !== "memberCount");
  let remaining = Math.max(0, width - used());
  for (const [index, col] of figures.entries()) {
    const extra = Math.floor(remaining / (figures.length - index));
    col.width += extra;
    col.flexGrow = 1;
    remaining -= extra;
  }
  return columns;
}
