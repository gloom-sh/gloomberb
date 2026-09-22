import type { DataTableColumn } from "../../../components";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import type {
  CloudJobsBucket,
  CloudJobsChange,
  CloudJobsMoverPayload,
  CloudJobsPosting,
  CloudJobsSummaryPayload,
} from "../../../api-client/types";
import { formatCompact, formatNumber } from "../../../utils/format";
import { compareSortValues } from "../../../utils/sort-values";

/**
 * Pure projections from the cloud payload to what the pane, the research tab
 * and the `fn` report draw. No React, no fetching.
 */

export const FUNCTION_LABELS: Record<string, string> = {
  engineering: "Engineering",
  data_ai: "Data & AI",
  product: "Product",
  design: "Design",
  sales: "Sales",
  marketing: "Marketing",
  customer: "Customer",
  operations: "Operations",
  supply_chain: "Supply chain",
  manufacturing: "Manufacturing",
  finance: "Finance",
  legal_compliance: "Legal & compliance",
  people: "People",
  research: "Research",
  clinical: "Clinical",
  retail: "Retail & hospitality",
  corporate: "Corporate",
  other: "Other",
  unclassified: "Unclassified",
};

const SENIORITY_SHORT: Record<string, string> = {
  intern: "Intern",
  entry: "Entry",
  mid: "Mid",
  senior: "Senior",
  lead: "Lead",
  manager: "Manager",
  director: "Director",
  executive: "Exec",
};

export function functionLabel(id: string | null | undefined): string {
  if (!id) return "Unclassified";
  return FUNCTION_LABELS[id] ?? id;
}

export function seniorityLabel(id: string | null | undefined): string {
  if (!id) return "";
  return SENIORITY_SHORT[id] ?? id;
}

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function seriesToChartPoints(summary: Pick<CloudJobsSummaryPayload, "series">): ProjectedChartPoint[] {
  return summary.series.map((point) => ({
    date: utcDate(point.day),
    open: point.open,
    high: point.open,
    low: point.open,
    close: point.open,
    // The first observed day has no meaningful "new" count; draw no bar.
    volume: point.new ?? 0,
  }));
}

/** The open-roles history, drawn once there is a week of daily points. */
export function historyChartPoints(summary: CloudJobsSummaryPayload): ProjectedChartPoint[] | null {
  return summary.series.length >= 7 ? seriesToChartPoints(summary) : null;
}

/** Open roles by posting age as share bars, oldest last. */
export function buildAgeBars(summary: Pick<CloudJobsSummaryPayload, "ageBuckets" | "openCount">): ShareBarRow[] {
  const buckets = summary.ageBuckets ?? [];
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return buckets.map((bucket) => ({
    key: bucket.id,
    label: bucket.label,
    count: bucket.count,
    share: summary.openCount > 0 ? bucket.count / summary.openCount : 0,
    ratio: bucket.count / max,
    delta: null,
  }));
}

export function formatChange(change: CloudJobsChange | null | undefined): string {
  if (!change) return "-";
  const sign = change.count > 0 ? "+" : "";
  const percent = change.percent != null ? ` (${sign}${formatNumber(change.percent, 1)}%)` : "";
  return `${sign}${change.count}${percent}`;
}

export function changeTone(value: number | null | undefined): "positive" | "negative" | "neutral" {
  if (value == null || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

export function formatShare(share: number): string {
  return `${formatNumber(share * 100, share >= 0.1 ? 0 : 1)}%`;
}

export function formatSalaryRange(
  min: number | null,
  max: number | null,
  currency: string | null,
  period: string | null,
): string {
  if (min == null && max == null) return "";
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : currency ? `${currency} ` : "";
  const fmt = (value: number) => (period === "hour" ? formatNumber(value, 0) : formatCompact(value));
  const range = min != null && max != null && min !== max
    ? `${symbol}${fmt(min)}–${fmt(max)}`
    : `${symbol}${fmt((min ?? max)!)}`;
  return period === "hour" ? `${range}/h` : period === "month" ? `${range}/mo` : range;
}

/** "3d", "6w", "4mo" from an ISO date, with a `+` when the date is a floor. */
export function formatAge(posted: string | null, precision: string | null, now = new Date()): string {
  if (!posted) return "";
  const days = Math.max(0, Math.round((now.getTime() - utcDate(posted).getTime()) / 86_400_000));
  const text = days < 1 ? "today" : days < 14 ? `${days}d` : days < 60 ? `${Math.round(days / 7)}w` : `${Math.round(days / 30)}mo`;
  return precision === "floor" ? `${text}+` : text;
}

export function formatCollectedAgo(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Postings table ------------------------------------------------------------

export type PostingColumnId = "title" | "function" | "location" | "posted" | "salary";
export type PostingColumn = DataTableColumn & { id: PostingColumnId };

export interface PostingRow {
  key: string;
  posting: CloudJobsPosting;
  title: string;
  function: string;
  seniority: string;
  location: string;
  posted: string;
  salary: string;
}

export function buildPostingRows(postings: readonly CloudJobsPosting[], now = new Date()): PostingRow[] {
  return postings.map((posting) => ({
    key: String(posting.id),
    posting,
    title: posting.title,
    function: functionLabel(posting.function),
    seniority: seniorityLabel(posting.seniority),
    location: posting.remote && !/remote/i.test(posting.location ?? "")
      ? `${posting.location ?? ""}${posting.location ? " · " : ""}Remote`
      : (posting.location ?? ""),
    posted: formatAge(posting.postedAt, posting.postedPrecision, now),
    salary: formatSalaryRange(posting.salaryMin, posting.salaryMax, posting.salaryCurrency, posting.salaryPeriod),
  }));
}

export function buildPostingColumns(width: number, hasSalary: boolean): PostingColumn[] {
  const narrow = width < 96;
  const fixed = narrow ? 14 + 18 + 7 : 24 + 24 + 8 + (hasSalary ? 14 : 0);
  const columns: PostingColumn[] = [
    { id: "title", label: "ROLE", width: Math.max(18, width - fixed - 6), align: "left", flexGrow: 1 },
    { id: "function", label: "FUNCTION", width: narrow ? 14 : 24, align: "left" },
    { id: "location", label: "LOCATION", width: narrow ? 18 : 24, align: "left" },
    { id: "posted", label: "POSTED", width: narrow ? 7 : 8, align: "right" },
  ];
  if (hasSalary && !narrow) columns.push({ id: "salary", label: "PAY", width: 14, align: "right" });
  return columns;
}

export interface PostingSort {
  columnId: PostingColumnId;
  direction: "asc" | "desc";
}

export const DEFAULT_POSTING_SORT: PostingSort = { columnId: "posted", direction: "desc" };

function postingSortValue(row: PostingRow, columnId: PostingColumnId): string | number | null {
  switch (columnId) {
    case "title":
      return row.title.toLowerCase();
    case "function":
      return row.function;
    case "location":
      return row.location;
    case "posted":
      return row.posting.postedAt ? utcDate(row.posting.postedAt).getTime() : new Date(row.posting.firstSeenAt).getTime();
    case "salary":
      return row.posting.salaryMax ?? row.posting.salaryMin;
  }
}

export function sortPostingRows(rows: PostingRow[], sort: PostingSort): PostingRow[] {
  return [...rows].sort((a, b) =>
    compareSortValues(postingSortValue(a, sort.columnId), postingSortValue(b, sort.columnId), sort.direction),
  );
}

export function nextPostingSort(current: PostingSort, columnId: string): PostingSort {
  const id = columnId as PostingColumnId;
  if (current.columnId === id) return { columnId: id, direction: current.direction === "asc" ? "desc" : "asc" };
  return { columnId: id, direction: id === "title" || id === "location" || id === "function" ? "asc" : "desc" };
}

// Share bars ----------------------------------------------------------------

export interface ShareBarRow {
  key: string;
  label: string;
  count: number;
  share: number;
  /** Fraction of the largest row, which is what the bar draws. */
  ratio: number;
  delta: number | null;
}

export function buildShareBars(buckets: readonly CloudJobsBucket[], limit: number, labelFor?: (id: string) => string): ShareBarRow[] {
  const sorted = [...buckets].sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  const rows = top.map((bucket) => ({
    key: bucket.id,
    label: labelFor ? labelFor(bucket.id) : bucket.label,
    count: bucket.count,
    share: bucket.share,
    ratio: 0,
    delta: bucket.previous != null ? bucket.count - bucket.previous : null,
  }));
  if (rest.length > 0) {
    const count = rest.reduce((sum, bucket) => sum + bucket.count, 0);
    const share = rest.reduce((sum, bucket) => sum + bucket.share, 0);
    rows.push({ key: "rest", label: `${rest.length} more`, count, share, ratio: 0, delta: null });
  }
  const max = Math.max(1, ...rows.map((row) => row.count));
  return rows.map((row) => ({ ...row, ratio: row.count / max }));
}

// Movers table --------------------------------------------------------------

export type MoverColumnId = "ticker" | "company" | "open" | "change" | "posted30d" | "new7d" | "function" | "country";
export type MoverColumn = DataTableColumn & { id: MoverColumnId };

export interface MoverRow {
  key: string;
  mover: CloudJobsMoverPayload;
  ticker: string;
  company: string;
  open: string;
  change: string;
  changeValue: number | null;
  posted30d: string;
  posted30dValue: number | null;
  new7d: string;
  function: string;
  country: string;
  countryShare: number | null;
}

export function buildMoverRows(movers: readonly CloudJobsMoverPayload[]): MoverRow[] {
  return movers.map((mover) => ({
    key: mover.ticker,
    mover,
    ticker: mover.ticker,
    company: mover.companyName ?? "",
    open: formatCompact(mover.openCount),
    change: mover.change30d ? formatChange(mover.change30d) : "",
    changeValue: mover.change30d?.percent ?? mover.change30d?.count ?? null,
    posted30d: mover.posted30d != null ? formatCompact(mover.posted30d) : "",
    posted30dValue: mover.posted30d ?? null,
    new7d: mover.new7d > 0 ? String(mover.new7d) : "",
    function: functionLabel(mover.topFunction),
    country: mover.topCountry ? `${mover.topCountry.code} ${formatShare(mover.topCountry.share)}` : "",
    countryShare: mover.topCountry?.share ?? null,
  }));
}

export function buildMoverColumns(width: number, hasHistory: boolean, hasWeek = true): MoverColumn[] {
  const narrow = width < 90;
  return [
    { id: "ticker", label: "TICKER", width: 8, align: "left" },
    { id: "company", label: "COMPANY", width: narrow ? 18 : 28, align: "left", flexGrow: 1 },
    { id: "open", label: "OPEN", width: 8, align: "right" },
    ...(hasHistory ? [{ id: "change" as const, label: "30D", width: 14, align: "right" as const }] : []),
    { id: "posted30d", label: "POSTED 30D", width: 11, align: "right" },
    ...(hasWeek ? [{ id: "new7d" as const, label: "NEW 7D", width: 8, align: "right" as const }] : []),
    ...(narrow ? [] : [{ id: "function" as const, label: "TOP FUNCTION", width: 18, align: "left" as const }]),
    ...(narrow ? [] : [{ id: "country" as const, label: "TOP COUNTRY", width: 12, align: "left" as const }]),
  ];
}

/** On a company's first read every role is "new this week"; the column says nothing until the next pass. */
export function moversHaveWeekHistory(rows: readonly MoverRow[]): boolean {
  return rows.some((row) => row.mover.new7d !== row.mover.openCount);
}

export interface MoverSort {
  columnId: MoverColumnId;
  direction: "asc" | "desc";
}

export const DEFAULT_MOVER_SORT: MoverSort = { columnId: "open", direction: "desc" };

function moverSortValue(row: MoverRow, columnId: MoverColumnId): string | number | null {
  switch (columnId) {
    case "ticker":
      return row.ticker;
    case "company":
      return row.company.toLowerCase();
    case "open":
      return row.mover.openCount;
    case "change":
      return row.changeValue;
    case "posted30d":
      return row.posted30dValue;
    case "country":
      return row.countryShare;
    case "new7d":
      return row.mover.new7d;
    case "function":
      return row.function;
  }
}

export function sortMoverRows(rows: MoverRow[], sort: MoverSort): MoverRow[] {
  return [...rows].sort((a, b) =>
    compareSortValues(moverSortValue(a, sort.columnId), moverSortValue(b, sort.columnId), sort.direction),
  );
}

export function nextMoverSort(current: MoverSort, columnId: string): MoverSort {
  const id = columnId as MoverColumnId;
  if (current.columnId === id) return { columnId: id, direction: current.direction === "asc" ? "desc" : "asc" };
  return { columnId: id, direction: id === "ticker" || id === "company" || id === "function" ? "asc" : "desc" };
}
