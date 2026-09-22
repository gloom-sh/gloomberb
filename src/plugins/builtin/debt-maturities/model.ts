import type {
  DebtHistoryPoint,
  DebtMaturitiesPayload,
  DebtMetric,
} from "../../../api-client/debt-maturities";
import type { DataTableColumn } from "../../../components";
import { formatCompact } from "../../../utils/format";

export type DebtLatest = NonNullable<DebtMaturitiesPayload["latest"]>;
export type DebtBucket = DebtLatest["buckets"][number];
export const debtAmount = (value: number | null) =>
  value === null ? "--" : formatCompact(value);
export const debtPercent = (value: number | null) =>
  value === null ? "--" : `${value.toFixed(1)}%`;
export const debtMetricValue = (metric: DebtMetric) =>
  metric.unit === "%"
    ? debtPercent(metric.value)
    : `${debtAmount(metric.value)} ${metric.unit}`;
export const debtMetricCaption = (metric: DebtMetric) =>
  `${metric.percentile.value === null ? "--" : metric.percentile.value.toFixed(0)} pctl 10Y · ${metric.asOf}`;
export function bucketShare(
  bucket: DebtBucket,
  latest: DebtLatest,
): number | null {
  const total = latest.totalPrincipal.value;
  return bucket.value !== null && total !== null && total > 0
    ? (100 * bucket.value) / total
    : null;
}
export const bucketPoints = (latest: DebtLatest) =>
  [null, ...latest.buckets.map((row) => row.value), null].map(
    (value, index) => ({
      // Ordinal anchors only. Null padding keeps the first and last columns inside the plot.
      // The axis names relative fiscal buckets and never exposes these synthetic dates.
      date: new Date(Date.UTC(2000, 0, index + 1)),
      observedAt: new Date(latest.asOf),
      value,
    }),
  );
export const BUCKET_AXIS_LABELS = [
  "Next 12m",
  "Year 2",
  "Year 3",
  "Year 4",
  "Year 5",
  "Thereafter",
];
export const bucketCursor = (ratio: number) =>
  BUCKET_AXIS_LABELS[Math.max(0, Math.min(5, Math.round(ratio * 7) - 1))] ?? "";
export const BUCKET_AXIS_TICKS = BUCKET_AXIS_LABELS.map((label, index) => ({
  label,
  ratio: (index + 1) / 7,
}));
export function recentDebtHistory(
  data: DebtMaturitiesPayload,
): DebtHistoryPoint[] {
  const start = data.latest?.totalPrincipal.percentile.windowStart;
  return start ? data.history.filter((point) => point.asOf >= start) : [];
}
export type BucketColumnId = "label" | "value" | "share";
export type BucketColumn = Omit<DataTableColumn, "id"> & { id: BucketColumnId };
export const BUCKET_COLUMNS: BucketColumn[] = [
  { id: "label", label: "MATURITY", width: 20, flexGrow: 1, align: "left" },
  { id: "value", label: "PRINCIPAL", width: 17, align: "right" },
  { id: "share", label: "% TOTAL", width: 12, align: "right" },
];
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
  // Standing scope and open-ended bucket methodology are documented, not repeated as active failures.
  return data.warnings.filter(
    (warning) =>
      !warning.startsWith(
        "Maturity amounts are reported principal obligations",
      ) && !warning.startsWith("Thereafter is open ended"),
  );
}
export const debtFilingUrl = (cik: string, accession: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}-index.htm`;
