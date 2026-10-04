import type { CpiBoardPayload, CpiReleaseStatus, CpiRow } from "../../../api-client/cpi";
import type { ChartStripSpec } from "../../../components/chart-table/header";
import { staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";

/**
 * The rows Gloom Cloud serves, by the ids its board uses, so `CPI shelter`
 * can open on one before the board has loaded. Aliases are the names a trader
 * types for them.
 */
export const CPI_ROW_OPTIONS: ReadonlyArray<{ value: string; label: string; aliases?: readonly string[] }> = [
  { value: "all-items", label: "All items", aliases: ["headline"] },
  { value: "core", label: "Core", aliases: ["ex food and energy"] },
  { value: "food", label: "Food" },
  { value: "food-at-home", label: "Food at home", aliases: ["groceries"] },
  { value: "food-away", label: "Food away from home", aliases: ["restaurants"] },
  { value: "energy", label: "Energy" },
  { value: "gasoline", label: "Gasoline" },
  { value: "electricity", label: "Electricity" },
  { value: "utility-gas", label: "Utility gas service", aliases: ["natural gas"] },
  { value: "core-goods", label: "Core goods" },
  { value: "new-vehicles", label: "New vehicles" },
  { value: "used-vehicles", label: "Used cars and trucks", aliases: ["used cars"] },
  { value: "apparel", label: "Apparel" },
  { value: "medical-goods", label: "Medical care goods" },
  { value: "core-services", label: "Core services" },
  { value: "shelter", label: "Shelter" },
  { value: "rent", label: "Rent" },
  { value: "oer", label: "Owners' equivalent rent" },
  { value: "lodging", label: "Lodging away from home", aliases: ["hotels"] },
  { value: "services-ex-shelter", label: "Services ex shelter", aliases: ["supercore"] },
  { value: "medical-services", label: "Medical care services" },
  { value: "transportation-services", label: "Transportation services" },
  { value: "auto-insurance", label: "Motor vehicle insurance", aliases: ["car insurance", "auto insurance"] },
  { value: "airfares", label: "Airline fares", aliases: ["airfare"] },
  { value: "recreation-services", label: "Recreation services" },
  { value: "education-communication", label: "Education and communication" },
];

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A typed row: its id, its label or one of its aliases ("shelter", "OER", "supercore"). */
export function cpiRowOption(input: string | undefined) {
  const typed = squash(input ?? "");
  if (!typed) return null;
  return CPI_ROW_OPTIONS.find((option) => [option.value, option.label, ...(option.aliases ?? [])]
    .some((name) => squash(name) === typed)) ?? null;
}

export type CpiSortColumn = "weight" | "change" | "annualized3m" | "annualized6m" | "yoy" | "contribution" | "contributionYoy";
export interface CpiSort {
  columnId: CpiSortColumn | null;
  direction: "asc" | "desc";
}
/** The release's own order: the BLS hierarchy, groups before their parts. */
export const CPI_TABLE_ORDER: CpiSort = { columnId: null, direction: "desc" };
const SORT_COLUMNS = new Set<string>(["weight", "change", "annualized3m", "annualized6m", "yoy", "contribution", "contributionYoy"]);
export const isCpiSortColumn = (value: string): value is CpiSortColumn => SORT_COLUMNS.has(value);

/**
 * All items and core first, as served; the rest in the BLS hierarchy, or by
 * a column with empty values last, so "what moved the headline" is one sort.
 */
export function cpiRows(payload: CpiBoardPayload, sort: CpiSort = CPI_TABLE_ORDER): CpiRow[] {
  const pinned = payload.rows.filter((row) => row.pinned);
  const rest = payload.rows.filter((row) => !row.pinned);
  const column = sort.columnId;
  if (!column) return [...pinned, ...rest];
  const sign = sort.direction === "asc" ? 1 : -1;
  const sorted = rest
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = a.row[column], right = b.row[column];
      if (left == null || right == null) return left == null ? (right == null ? a.index - b.index : 1) : -1;
      return (left - right) * sign || a.index - b.index;
    })
    .map(({ row }) => row);
  return [...pinned, ...sorted];
}

/**
 * The row's name, indented under its group while the table is in the
 * release's order. The indent is no-break spaces: table cells do not wrap, and
 * on the desktop that also folds ordinary leading spaces away.
 */
export function cpiRowLabel(row: CpiRow, hierarchy: boolean): string {
  return hierarchy ? `${"\u00a0\u00a0".repeat(row.depth)}${row.label}` : row.label;
}

/** A change that rounds to zero reads 0.00, never -0.00. */
function signed(value: number, decimals: number): string {
  const text = Math.abs(value).toFixed(decimals);
  return `${Number(text) === 0 ? "" : value > 0 ? "+" : "-"}${text}`;
}

/** Percent changes as the pane shows them: two decimals, signed, no unit (the header names it). */
export const formatCpiChange = (value: number | null) => value == null ? "--" : signed(value, 2);
/** Contributions in percentage points, two decimals, signed. */
export const formatCpiPoints = (value: number | null) => value == null ? "--" : signed(value, 2);
/** Share of the basket, percent: one decimal. */
export const formatCpiWeight = (value: number | null) => value == null ? "--" : value.toFixed(1);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Aug 2026" from 2026-08. */
export function cpiMonth(period: string): string {
  return `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
}

/** A release instant on BLS's own clock: "Wed Oct 14 08:30 ET". */
function releaseTime(iso: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.month} ${parts.day} ${parts.hour}:${parts.minute} ET`;
}

/**
 * The month the data covers, when it came out and when the next release is
 * due, on one line: "Aug 2026 · released Fri Sep 11 08:30 ET · next Wed Oct
 * 14 08:30 ET". A release past its time and not in yet reads "due".
 */
export function cpiHeaderLine(release: CpiReleaseStatus, now = Date.now()): string | undefined {
  if (!release.period) return undefined;
  const parts = [cpiMonth(release.period)];
  if (release.releasedAt) parts.push(`released ${releaseTime(release.releasedAt)}`);
  if (release.nextReleaseAt) parts.push(`${Date.parse(release.nextReleaseAt) <= now ? "due" : "next"} ${releaseTime(release.nextReleaseAt)}`);
  return parts.join(" · ");
}

/** The first of the month a change is for, which the chart plots it on. */
export const cpiMonthDate = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1));

/**
 * The chart's x axis over a row's months: a tick at each January, labelled
 * with its year, and the cursor read as a month ("Aug 2026") rather than a day.
 */
export function cpiTimeAxis(history: CpiRow["history"]) {
  const first = history[0]?.[0], last = history.at(-1)?.[0];
  if (!first || !last || first === last) return null;
  const start = cpiMonthDate(first).getTime(), end = cpiMonthDate(last).getTime();
  const ratio = (time: number) => (time - start) / (end - start);
  const ticks = [];
  for (let year = Number(first.slice(0, 4)) + 1; year <= Number(last.slice(0, 4)); year++)
    ticks.push({ label: String(year), ratio: ratio(Date.UTC(year, 0, 1)) });
  return {
    viewport: { start: new Date(start), end: new Date(end) },
    xAxis: {
      ticks,
      formatCursor: (xRatio: number) => {
        const at = new Date(start + Math.min(1, Math.max(0, xRatio)) * (end - start) + 15 * 86_400_000);
        return cpiMonth(at.toISOString().slice(0, 7));
      },
    },
  };
}

export interface CpiChartColors {
  positive: string;
  negative: string;
  warning: string;
  textDim: string;
}

const MONTH_UNIT = { unit: "%", unitGroup: "cpi-month" } as const;
const YEAR_UNIT = { unit: "%", unitGroup: "cpi-year" } as const;

/**
 * The selected row's monthly changes as columns on the left axis and its
 * year-over-year change as a line on the right, with the headline's
 * year-over-year line for reference (left out on the headline itself).
 */
export function cpiChartSeries(row: CpiRow, headline: CpiRow | null, colors: CpiChartColors): ResolvedSeries[] {
  const points = (history: CpiRow["history"], pick: 1 | 2) => history.flatMap(([period, ...values]) => {
    const value = values[pick - 1];
    if (value == null) return [];
    const date = cpiMonthDate(period);
    return [{ date, observedAt: date, value }];
  });
  const series: ResolvedSeries[] = [
    { ...staticSeries(points(row.history, 1), { id: "month", label: `${row.label} m/m`, color: colors.positive,
      negativeColor: colors.negative, style: "columns", calendarSpaced: true }), ...MONTH_UNIT, axis: "left" },
    { ...staticSeries(points(row.history, 2), { id: "year", label: `${row.label} y/y`, color: colors.warning, calendarSpaced: true }),
      ...YEAR_UNIT, axis: "right" },
  ];
  if (headline && headline.id !== row.id)
    series.push({ ...staticSeries(points(headline.history, 2), { id: "headline", label: `${headline.label} y/y`, color: colors.textDim,
      calendarSpaced: true }), ...YEAR_UNIT, axis: "right" });
  return series.filter((entry) => entry.points.length > 0);
}

/** One row for a short pane: the row's year-over-year line and its latest value. */
export function cpiChartStrip(row: CpiRow, color: string): ChartStripSpec | null {
  const values = row.history.flatMap(([, , yoy]) => (yoy == null ? [] : [yoy]));
  if (values.length < 2 || row.yoy == null) return null;
  return { label: `${row.label} y/y`, values, value: `${row.yoy.toFixed(2)}%`, color };
}
