import type {
  DebtHistoryPoint,
  DebtMaturitiesPayload,
  DebtMetric,
} from "../../../api-client/debt-maturities";
import type { CompositeAxisDomain, DataTableColumn } from "../../../components";
import { spanDigits } from "../../../components/chart-table";
import { scalarPoint } from "../../../components/chart/static/series";
import type { TimeSeriesPoint } from "../../../time-series/types";
import { formatCompact, formatPercentileRank } from "../../../utils/format";

export type DebtLatest = NonNullable<DebtMaturitiesPayload["latest"]>;
export type DebtBucket = DebtLatest["buckets"][number];
export const debtAmount = (value: number | null) =>
  value === null ? "--" : formatCompact(value, { fixedDecimals: true });
export const debtPercent = (value: number | null) =>
  value === null ? "--" : `${value.toFixed(1)}%`;
export const debtMetricValue = (metric: DebtMetric) =>
  metric.unit === "%"
    ? debtPercent(metric.value)
    : `${debtAmount(metric.value)} ${metric.unit}`;
export const debtMetricCaption = (metric: DebtMetric) =>
  `${formatPercentileRank(metric.percentile.value, "10Y")} · ${metric.asOf}`;
export function bucketShare(
  bucket: DebtBucket,
  latest: DebtLatest,
): number | null {
  const total = latest.totalPrincipal.value;
  return bucket.value !== null && total !== null && total > 0
    ? (100 * bucket.value) / total
    : null;
}
/**
 * The wall's scale: the largest dated bucket. Thereafter is open ended and
 * usually dwarfs every dated year, so scaling to it would flatten them.
 */
export function datedBucketScale(latest: DebtLatest): number {
  return Math.max(
    0,
    ...latest.buckets.flatMap((row) =>
      row.year !== null && row.value !== null ? [row.value] : [],
    ),
  );
}
export interface BucketBar {
  /** Share of the bar column, 0 to 1. */
  ratio: number;
  /** Past the dated scale: drawn to the end and labelled with its value. */
  capped: boolean;
}
export function bucketBar(bucket: DebtBucket, scale: number): BucketBar | null {
  if (bucket.value === null) return null;
  if (scale <= 0) return { ratio: bucket.value > 0 ? 1 : 0, capped: bucket.value > 0 };
  const ratio = bucket.value / scale;
  return ratio > 1 ? { ratio: 1, capped: true } : { ratio, capped: false };
}
function recentDebtHistory(
  data: DebtMaturitiesPayload,
): DebtHistoryPoint[] {
  const start = data.latest?.totalPrincipal.percentile.windowStart;
  return start ? data.history.filter((point) => point.asOf >= start) : [];
}
/** The comparable window's filings, oldest first: the order the bars read. */
export function historyBars(data: DebtMaturitiesPayload): DebtHistoryPoint[] {
  return recentDebtHistory(data).toSorted((a, b) => a.asOf.localeCompare(b.asOf));
}
const DAY_MS = 86_400_000;
/**
 * One slot per filing, with an empty slot at each end so the outer bars sit
 * inside the plot. The filings are a year apart, so slots read as calendar.
 */
export function historyChartPoints(bars: readonly DebtHistoryPoint[]): TimeSeriesPoint[] {
  if (!bars.length) return [];
  const first = Date.parse(bars[0]!.asOf), last = Date.parse(bars.at(-1)!.asOf);
  return [
    scalarPoint(new Date(first - DAY_MS), null),
    ...bars.map((row) => scalarPoint(new Date(row.asOf), row.totalPrincipal)),
    scalarPoint(new Date(last + DAY_MS), null),
  ];
}
/** Each filing's year under its own bar; fiscal years end in any month, so calendar ticks would fall between bars. */
export function historyAxis(bars: readonly DebtHistoryPoint[]) {
  const slots = bars.length + 1;
  return {
    ticks: bars.map((row, index) => ({ label: row.asOf.slice(0, 4), ratio: (index + 1) / slots })),
    formatCursor: (ratio: number) =>
      bars[Math.max(0, Math.min(bars.length - 1, Math.round(ratio * slots) - 1))]?.asOf ?? "",
  };
}
const AXIS_UNITS = [
  { divisor: 1e12, suffix: "T" },
  { divisor: 1e9, suffix: "B" },
  { divisor: 1e6, suffix: "M" },
  { divisor: 1e3, suffix: "k" },
  { divisor: 1, suffix: "" },
] as const;
/** Compact amounts whose decimals follow the plotted range, so ticks never repeat. */
export function debtAxisAmount(value: number, domain: CompositeAxisDomain): string {
  if (value === 0) return "0";
  const top = Math.max(Math.abs(domain.min), Math.abs(domain.max));
  const unit = AXIS_UNITS.find((entry) => top >= entry.divisor) ?? AXIS_UNITS.at(-1)!;
  const digits = spanDigits({ min: domain.min / unit.divisor, max: domain.max / unit.divisor });
  return `${(value / unit.divisor).toFixed(digits)}${unit.suffix}`;
}
export type BucketColumnId = "label" | "value" | "share" | "wall";
export type BucketColumn = Omit<DataTableColumn, "id"> & { id: BucketColumnId };
const BUCKET_TEXT_COLUMNS: BucketColumn[] = [
  { id: "label", label: "MATURITY", width: 15, align: "left" },
  { id: "value", label: "PRINCIPAL", width: 10, align: "right" },
  { id: "share", label: "% TOTAL", width: 8, align: "right" },
];
/** Below this the wall bars are too short to compare. */
const MIN_WALL_WIDTH = 10;
/** Past this a longer bar adds ink, not resolution. */
const MAX_WALL_WIDTH = 48;
/**
 * The maturity table with the wall drawn inline: the bar column takes what
 * the text columns leave, and a pane too narrow for it keeps the numbers.
 */
export function bucketColumns(width: number): BucketColumn[] {
  // Each column is followed by a one-cell gap and the table pads both edges;
  // the body's scrollbar gutter takes the rest, so the wall never scrolls.
  const textWidth = BUCKET_TEXT_COLUMNS.reduce((sum, column) => sum + column.width + 1, 2);
  const wall = Math.min(MAX_WALL_WIDTH, width - textWidth - 3);
  if (wall < MIN_WALL_WIDTH) return BUCKET_TEXT_COLUMNS;
  return [
    ...BUCKET_TEXT_COLUMNS,
    { id: "wall", label: "WALL", width: wall, align: "left" },
  ];
}
export type HistoryColumnId =
  | "asOf"
  | "totalPrincipal"
  | "next12MonthsShare"
  | "next3YearsShare"
  | "interestExpense"
  | "filed";
export type HistoryColumn = Omit<DataTableColumn, "id"> & {
  id: HistoryColumnId;
};
export const HISTORY_COLUMNS: HistoryColumn[] = [
  { id: "asOf", label: "AS OF", width: 13, align: "left" },
  { id: "totalPrincipal", label: "PRINCIPAL", width: 14, align: "right" },
  { id: "next12MonthsShare", label: "NEXT 12M %", width: 14, align: "right" },
  { id: "next3YearsShare", label: "NEXT 3Y %", width: 13, align: "right" },
  { id: "interestExpense", label: "INTEREST", width: 13, align: "right" },
  { id: "filed", label: "FILED", width: 13, flexGrow: 1, align: "left" },
];
export interface DebtSort<K extends string> {
  column: K;
  direction: "asc" | "desc";
}
function compare(
  left: string | number | null,
  right: string | number | null,
  direction: "asc" | "desc",
): number {
  if (left === null || right === null)
    return left === null ? (right === null ? 0 : 1) : -1;
  return (
    (left < right ? -1 : left > right ? 1 : 0) * (direction === "asc" ? 1 : -1)
  );
}
export function sortedBuckets(
  latest: DebtLatest,
  sort: DebtSort<BucketColumnId>,
): DebtBucket[] {
  // The wall bar draws the principal, so it sorts with it.
  const value = (row: DebtBucket) =>
    sort.column === "label"
      ? latest.buckets.indexOf(row)
      : sort.column === "share"
        ? bucketShare(row, latest)
        : row.value;
  return latest.buckets.toSorted(
    (a, b) =>
      compare(value(a), value(b), sort.direction) ||
      latest.buckets.indexOf(a) - latest.buckets.indexOf(b),
  );
}
export function sortedDebtHistory(
  data: DebtMaturitiesPayload,
  sort: DebtSort<HistoryColumnId>,
): DebtHistoryPoint[] {
  return recentDebtHistory(data).toSorted(
    (a, b) =>
      compare(a[sort.column], b[sort.column], sort.direction) ||
      b.asOf.localeCompare(a.asOf),
  );
}
export function debtNotices(data: DebtMaturitiesPayload): string[] {
  // Standing scope and open-ended bucket methodology are documented, not repeated as
  // active failures. The backend stops sending them; this covers older servers and caches.
  return data.warnings.filter(
    (warning) =>
      !warning.startsWith(
        "Maturity amounts are reported principal obligations",
      ) && !warning.startsWith("Thereafter is open ended"),
  );
}
export const debtFilingUrl = (cik: string, accession: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}-index.htm`;
