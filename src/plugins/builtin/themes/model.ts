import { THEME_PERIODS, type ThemeAggregate, type ThemeMember, type ThemePeriod, type ThemeSummary } from "../../../api-client/themes";
import type { DataTableColumn } from "../../../components";
import { getTableWidth } from "../../../components/ui/table-layout";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";

export const PERIOD_LABELS: Record<ThemePeriod, string> = { changePercent: "1D", return1WPercent: "1W", return1MPercent: "1M", return3MPercent: "3M", returnYtdPercent: "YTD" };
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
  const value = (row: ThemeMember) => row[sort.columnId as "price" | "symbol" | "name"];
  return [...rows].sort((a, b) => compareSortValues(value(a), value(b), sort.direction) || a.symbol.localeCompare(b.symbol));
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
/** Drop leaders/laggards first, then longer windows; keep the day's move and breadth. */
export function themeColumns(width: number, rows: readonly ThemeSummary[]): DataTableColumn[] {
  const suffixWidth = (period: ThemePeriod) => coverageWidth(rows.map((row) => row.returns[period]));
  const metricWidth = (period: ThemePeriod) => Math.max(8, ...rows.map((row) => percent(row.returns[period].value).length)) + suffixWidth(period);
  const columns = [column("name", "Theme", 26, "left"), column("memberCount", "N", 3),
    // The same trailing space is reserved in every cell and its header. A note
    // occupies that space without moving the number away from its label.
    ...THEME_PERIODS.map((period) => column(period, PERIOD_LABELS[period] + " ".repeat(suffixWidth(period)), metricWidth(period))),
    column("breadth", "Breadth" + " ".repeat(coverageWidth(rows.map((row) => row.breadth))), 7 + coverageWidth(rows.map((row) => row.breadth))),
    column("best", "Best 1D", 15), column("worst", "Worst 1D", 15)];
  return fitColumns(columns, width, ["worst", "best", "return3MPercent", "returnYtdPercent", "return1MPercent", "return1WPercent", "memberCount"]);
}
export function memberColumns(width: number): DataTableColumn[] {
  return fitColumns([column("symbol", "Ticker", 7, "left"), column("name", "Name", 24, "left"), column("price", "Price $", 10),
    ...THEME_PERIODS.map((period) => column(period, PERIOD_LABELS[period], 9))], width,
  ["return3MPercent", "returnYtdPercent", "return1MPercent", "return1WPercent", "name", "price"]);
}
function fitColumns(columns: DataTableColumn[], width: number, drop: string[]): DataTableColumn[] {
  const used = () => getTableWidth(columns);
  for (const id of drop) {
    if (used() <= width) break;
    columns = columns.filter((col) => col.id !== id);
  }
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
