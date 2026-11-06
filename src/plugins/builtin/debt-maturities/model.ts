import type {
  DebtAmountBasis,
  DebtBand,
  DebtHistoryPoint,
  DebtMaturitiesPayload,
  DebtMetric,
  DebtQuarter,
} from "../../../api-client/debt-maturities";
import type { DataTableColumn } from "../../../components";
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
 * The bands of a schedule read in its filing's own bands (within 1 year,
 * 1 to 2 years, 2 to 5 years, after 5 years), exactly as reported; null for
 * a schedule by fiscal year.
 */
export function debtBands(latest: DebtLatest | null | undefined): DebtBand[] | null {
  return latest?.sourceBuckets?.length ? latest.sourceBuckets : null;
}
/** What a schedule's amounts are, as its table header, its total and its filing detail name them. */
const BASIS: Record<DebtAmountBasis, { column: string; amount: string; total: string; words: string; detail?: string }> = {
  principal: { column: "PRINCIPAL", amount: "Principal", total: "Principal total", words: "Principal" },
  carrying: { column: "CARRYING", amount: "Carrying amount", total: "Carrying total", words: "Carrying amounts" },
  contractual_undiscounted: {
    column: "CASH FLOWS",
    amount: "Cash flows",
    total: "Cash flows total",
    words: "Contractual undiscounted cash flows",
    detail: "principal and interest",
  },
};
export const debtBasis = (latest: DebtLatest) => BASIS[latest.amountBasis ?? "principal"];
const STANDARDS: Record<string, string> = { "us-gaap": "US GAAP", "ifrs-full": "IFRS", "cn-cas": "China CAS" };
/** The accounting standard a schedule is drawn up under: `IFRS`, `China CAS`. */
export const debtStandard = (taxonomy: string | null | undefined) =>
  taxonomy ? (STANDARDS[taxonomy] ?? taxonomy) : null;
/** The bands' sum: the schedule's total in its own basis. */
export const bandTotal = (bands: readonly DebtBand[]) => bands.reduce((sum, band) => sum + band.value, 0);
/**
 * The share of the bands' total due within `months` of the balance-sheet
 * date, only when the bands from the first end exactly there: a band that
 * spans the point is never split, so there is then no share.
 */
export function bandsDueWithin(bands: readonly DebtBand[], months: number): number | null {
  const end = bands.findIndex((band) => band.toMonths === months);
  const total = bandTotal(bands);
  if (end < 0 || bands[0]?.fromMonths !== 0 || total <= 0) return null;
  return (100 * bandTotal(bands.slice(0, end + 1))) / total;
}
/** How the report states its amounts: `HKD millions`, `TWD`; `HKD millions, scale not stated` when the table did not say. */
export function bandScaleText(currency: string, scale: number | undefined, stated = true): string {
  const unit = scale === 1e9 ? " billions" : scale === 1e6 ? " millions" : scale === 1e3 ? " thousands"
    : scale && scale !== 1 ? ` × ${scale.toLocaleString("en-US")}` : "";
  return `${currency}${unit}${stated ? "" : ", scale not stated"}`;
}
/**
 * One row of the maturity table: a fiscal year of a schedule by year, or a
 * band of one in its filing's own bands, as reported. `dated` rows share the
 * wall's scale; the open-ended last one is capped past it.
 */
export interface MaturityRow {
  id: string;
  label: string;
  value: number | null;
  /** Share of the schedule's total, in percent; null without a total. */
  share: number | null;
  dated: boolean;
  bucket?: DebtBucket;
  band?: DebtBand;
}
export function maturityRows(latest: DebtLatest): MaturityRow[] {
  const bands = debtBands(latest);
  if (!bands) {
    return latest.buckets.map((bucket) => ({
      id: bucket.id, label: bucket.label, value: bucket.value, share: bucketShare(bucket, latest),
      dated: bucket.year !== null, bucket,
    }));
  }
  const total = bandTotal(bands);
  return bands.map((band) => ({
    id: `${band.fromMonths}-${band.toMonths ?? "on"}`, label: band.label, value: band.value,
    share: total > 0 ? (100 * band.value) / total : null, dated: band.toMonths !== null, band,
  }));
}
/**
 * The wall's scale: the largest dated bucket. Thereafter is open ended and
 * usually dwarfs every dated year, so scaling to it would flatten them.
 */
export function datedBucketScale(latest: DebtLatest): number {
  return Math.max(
    0,
    ...maturityRows(latest).flatMap((row) =>
      row.dated && row.value !== null ? [row.value] : [],
    ),
  );
}
export interface BucketBar {
  /** Share of the bar column, 0 to 1. */
  ratio: number;
  /** Past the dated scale: drawn to the end and labelled with its value. */
  capped: boolean;
}
export function bucketBar(bucket: Pick<MaturityRow, "value">, scale: number): BucketBar | null {
  if (bucket.value === null) return null;
  if (scale <= 0) return { ratio: bucket.value > 0 ? 1 : 0, capped: bucket.value > 0 };
  const ratio = bucket.value / scale;
  return ratio > 1 ? { ratio: 1, capped: true } : { ratio, capped: false };
}
/**
 * The comparable filings: the ten-year window of a schedule by year. A
 * schedule in its filing's own bands has no principal by year to compare.
 */
function recentDebtHistory(
  data: DebtMaturitiesPayload,
): DebtHistoryPoint[] {
  if (debtBands(data.latest)) return [];
  const start = data.latest?.totalPrincipal.percentile.windowStart;
  return start ? data.history.filter((point) => point.asOf >= start) : [];
}
/** The comparable window's filings, oldest first: the order the bars read. */
export function historyBars(data: DebtMaturitiesPayload): DebtHistoryPoint[] {
  return recentDebtHistory(data).toSorted((a, b) => a.asOf.localeCompare(b.asOf));
}
const DAY_MS = 86_400_000;
/**
 * Where a filing chart puts its filings: one slot each, the filings a year
 * apart so the slots read as calendar. `edges` adds an empty slot at each end
 * so the outer bars of a column chart sit inside the plot; a line chart goes
 * edge to edge, so its idle legend reads the newest filing, not an empty slot.
 */
interface HistorySlots {
  edges?: boolean;
}
/**
 * The fiscal year a filing's period closes: SEC's `fy` when the server sends
 * it, else the year the period ends in. A 52- or 53-week year that ends in
 * the first week of January belongs to the year before: one ending
 * 2026-01-03 is fiscal 2025, so a retailer's years are not labelled one late
 * or twice.
 */
export function fiscalYearOf(point: Pick<DebtHistoryPoint, "asOf" | "fy">): number {
  if (typeof point.fy === "number" && Number.isInteger(point.fy)) return point.fy;
  const year = Number(point.asOf.slice(0, 4));
  return point.asOf.slice(5, 7) === "01" && Number(point.asOf.slice(8, 10)) <= 7 ? year - 1 : year;
}

/** The filings' points in their slots; `historyAxis` with the same slots labels them. */
export function historyChartPoints(
  bars: readonly DebtHistoryPoint[],
  value: (row: DebtHistoryPoint) => number | null = (row) => row.totalPrincipal,
  { edges = true }: HistorySlots = {},
): TimeSeriesPoint[] {
  if (!bars.length) return [];
  const points = bars.map((row) => scalarPoint(new Date(row.asOf), value(row)));
  if (!edges) return points;
  const first = Date.parse(bars[0]!.asOf), last = Date.parse(bars.at(-1)!.asOf);
  return [scalarPoint(new Date(first - DAY_MS), null), ...points, scalarPoint(new Date(last + DAY_MS), null)];
}
/**
 * Each filing's year under its own slot of `historyChartPoints`. Fiscal years
 * end in any month, so calendar ticks would fall beside the points: a
 * December year end sits next to the next year's January tick, one filing off.
 */
export function historyAxis(bars: readonly DebtHistoryPoint[], { edges = true }: HistorySlots = {}) {
  const offset = edges ? 1 : 0;
  // Slots from the first point to the last.
  const span = bars.length - 1 + 2 * offset;
  return {
    ticks: bars.map((row, index) => ({ label: String(fiscalYearOf(row)), ratio: span > 0 ? (index + offset) / span : 0.5 })),
    formatCursor: (ratio: number) =>
      bars[Math.max(0, Math.min(bars.length - 1, Math.round(ratio * span) - offset))]?.asOf ?? "",
  };
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
 * `amount` heads the amounts column (`CARRYING` for carrying amounts).
 */
export function bucketColumns(width: number, amount = "PRINCIPAL"): BucketColumn[] {
  const text = BUCKET_TEXT_COLUMNS.map((column) => column.id === "value" ? { ...column, label: amount } : column);
  // Each column is followed by a one-cell gap and the table pads both edges;
  // the body's scrollbar gutter takes the rest, so the wall never scrolls.
  const textWidth = text.reduce((sum, column) => sum + column.width + 1, 2);
  const wall = Math.min(MAX_WALL_WIDTH, width - textWidth - 3);
  if (wall < MIN_WALL_WIDTH) return text;
  return [
    ...text,
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
): MaturityRow[] {
  const rows = maturityRows(latest);
  // The wall bar draws the amount, so it sorts with it.
  const value = (row: MaturityRow) =>
    sort.column === "label"
      ? rows.indexOf(row)
      : sort.column === "share"
        ? row.share
        : row.value;
  return rows.toSorted(
    (a, b) =>
      compare(value(a), value(b), sort.direction) ||
      rows.indexOf(a) - rows.indexOf(b),
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
/**
 * What a year's cost proxy divides: `filed`, the filing's debt-only interest
 * over the debt balances it reports; `average-principal`, the year's interest
 * expense over its average scheduled principal.
 */
export type DebtCostProxyKind = "filed" | "average-principal";

/** A year's cost proxy: the value, what it divides when there is one, and why not when there is none. */
export interface DebtCostProxy {
  value: number | null;
  kind: DebtCostProxyKind | null;
  basis: string | null;
  reason: string | null;
}

/**
 * A year's borrowing cost proxy, in percent. The filing's own when it has
 * one (debt interest over its reported debt balances, as the server reads
 * it); else the year's interest expense over the average of its opening and
 * closing scheduled principal, the opening one being the schedule a year
 * earlier in `history`. With neither, null and the reason.
 */
export function debtCostProxy(history: readonly DebtHistoryPoint[], point: DebtHistoryPoint): DebtCostProxy {
  if (point.borrowingCostPercent !== null) {
    return { value: point.borrowingCostPercent, kind: "filed", basis: point.borrowingCostDebtTags, reason: null };
  }
  const none = (reason: string): DebtCostProxy => ({ value: null, kind: null, basis: null, reason });
  if (point.interestExpense === null) return none("no annual interest expense reported");
  if (point.totalPrincipal === null) return none("partial principal schedule");
  const opening = history.find((row) => {
    const days = (Date.parse(point.asOf) - Date.parse(row.asOf)) / DAY_MS;
    return days >= 350 && days <= 380;
  });
  if (!opening) return none("no schedule a year earlier to average");
  if (opening.totalPrincipal === null) return none(`partial principal schedule at ${opening.asOf}`);
  const average = (opening.totalPrincipal + point.totalPrincipal) / 2;
  if (average <= 0) return none("no principal to average");
  return {
    value: (100 * point.interestExpense) / average,
    kind: "average-principal",
    basis: `Interest over average principal since ${opening.asOf}`,
    reason: null,
  };
}

/**
 * The annual history as DDIS prints and exports it, newest first: each year's
 * cost proxy as `debtCostProxy` reads it, and `borrowingCostBasis` naming what
 * it divides (`filed` or `average-principal`; null with no proxy).
 */
export function debtHistoryRows(history: readonly DebtHistoryPoint[]): Array<DebtHistoryPoint & { borrowingCostBasis: DebtCostProxyKind | null }> {
  return history.toReversed().map((point) => {
    const cost = debtCostProxy(history, point);
    return { ...point, borrowingCostPercent: cost.value, borrowingCostBasis: cost.kind };
  });
}

/** The note for the years a cost proxy cannot be read for: "Cost proxy %: none for 2021-12-31 (no schedule a year earlier to average)." */
export function debtCostProxyNote(history: readonly DebtHistoryPoint[]): string | null {
  const missing = history.toReversed().flatMap((point) => {
    const { reason } = debtCostProxy(history, point);
    return reason ? [`${point.asOf} (${reason})`] : [];
  });
  return missing.length > 0 ? `Cost proxy %: none for ${missing.join(", ")}.` : null;
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
/**
 * The latest 10-Q when it is newer than the annual schedule, as the server
 * sends it; null for an issuer whose last filing is its annual one, and for
 * an older server or cached payload that has no field for it.
 */
export function newerQuarter(data: DebtMaturitiesPayload): DebtQuarter | null {
  const quarter = data.latestQuarter ?? null;
  return quarter && data.latest && quarter.asOf > data.latest.asOf ? quarter : null;
}
/** The newest filing the payload reports: the 10-Q when it is newer, else the annual schedule's. */
function newestDebtFiling(data: DebtMaturitiesPayload): Pick<DebtQuarter, "form" | "asOf" | "filed"> | null {
  return newerQuarter(data) ?? data.latest ?? null;
}
/** The newest balance date the payload reports: the 10-Q's when it is newer, else the schedule's. */
export function debtNewestAsOf(data: DebtMaturitiesPayload): string | null {
  return newestDebtFiling(data)?.asOf ?? null;
}
/** The form of the filing `debtNewestAsOf` dates, which names that date: `10-Q`, `10-K`. */
export function debtNewestForm(data: DebtMaturitiesPayload): string | null {
  return newestDebtFiling(data)?.form ?? null;
}
/**
 * Which filing the pane's date is, as its footer says it, longest first:
 * `10-Q 2026-09-30, filed 2026-10-27`, then `10-Q 2026-09-30`.
 */
export function debtNewestFilingText(data: DebtMaturitiesPayload): string[] {
  const filing = newestDebtFiling(data);
  return filing ? [`${filing.form} ${filing.asOf}, filed ${filing.filed}`, `${filing.form} ${filing.asOf}`] : [];
}
/** The 10-Q's debt in one line, `Current 212.00M · Non-current 6.84B USD`. */
export function quarterDebtText(quarter: DebtQuarter): string {
  return `Current ${debtAmount(quarter.current?.value ?? null)} · Non-current ${debtAmount(quarter.noncurrent?.value ?? null)} ${quarter.currency}`;
}
export const debtFilingUrl = (cik: string, accession: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}-index.htm`;
