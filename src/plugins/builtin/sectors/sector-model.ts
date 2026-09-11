import type { DataTableColumn } from "../../../components";
import type { PricePoint } from "../../../types/financials";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { getPricePointTimestamp } from "../../../utils/price-history";
import { mergePriceHistoryIntegrity, pricePointIntegrity, type PriceHistoryIntegrity } from "../../../utils/price-history-integrity";
import {
  getSectorCollection,
  type SectorCollectionId,
  type SectorDef,
} from "./sector-data";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_COLLECTION_ID: SectorCollectionId = "sectors";

export interface SectorRow extends SectorDef {
  price: number | null;
  changePercent: number | null;
  return1M: number | null;
  return1Y: number | null;
  currency: string;
  loading: boolean;
  quoteUnavailable?: boolean;
  quoteSessionDate?: string | null;
  quoteIssue?: string | null;
  lastReportedPrice?: number | null;
  returnIntegrity?: Partial<Record<SectorReturnRange, PriceHistoryIntegrity>>;
  returnAsOfDate?: string | null;
  return1MStartDate?: string | null;
  return1YStartDate?: string | null;
}

type SectorColumnId = "name" | "etf" | "price" | "changePercent" | "return1M" | "return1Y" | "bar";
export type SectorColumn = DataTableColumn & { id: SectorColumnId };
export type SectorRowsByCollection = Record<SectorCollectionId, SectorRow[]>;
export type SectorRefreshByCollection = Partial<Record<SectorCollectionId, number>>;

export interface SectorSortPreference {
  columnId: SectorColumnId;
  direction: SortDirection;
}

export const DEFAULT_SORT_PREFERENCE: SectorSortPreference = {
  columnId: "changePercent",
  direction: "desc",
};

/** Full length at a 5% session move, which covers all but crash days. */
const MOVE_BAR_FULL_SCALE_PERCENT = 5;

/** 0..1 length for a session move, monotonic in the size of the move. */
export function moveBarRatio(changePercent: number): number {
  return Math.min(1, Math.abs(changePercent) / MOVE_BAR_FULL_SCALE_PERCENT);
}

function createLoadingRows(sectors: readonly SectorDef[]): SectorRow[] {
  return sectors.map((sector) => ({
    ...sector,
    price: null,
    changePercent: null,
    return1M: null,
    return1Y: null,
    currency: "USD",
    loading: true,
  }));
}

function createRowsByCollection(): SectorRowsByCollection {
  return {
    sectors: createLoadingRows(getSectorCollection("sectors").items),
    industries: createLoadingRows(getSectorCollection("industries").items),
  };
}

export const INITIAL_ROWS_BY_COLLECTION = createRowsByCollection();
export const INITIAL_REFRESH_BY_COLLECTION: SectorRefreshByCollection = {};

export function normalizeRowsForCollection(
  rowsByCollection: SectorRowsByCollection,
  collectionId: SectorCollectionId,
  items: readonly SectorDef[] = getSectorCollection(collectionId).items,
): SectorRow[] {
  const rows = rowsByCollection[collectionId] ?? [];
  return items.map((sector) => {
    const existing = rows.find((row) => row.etf === sector.etf);
    return {
      ...sector,
      price: existing?.price ?? null,
      changePercent: existing?.changePercent ?? null,
      return1M: existing?.return1M ?? null,
      return1Y: existing?.return1Y ?? null,
      currency: existing?.currency ?? "USD",
      loading: existing?.loading ?? true,
      quoteUnavailable: existing?.quoteUnavailable ?? false,
      quoteSessionDate: existing?.quoteSessionDate ?? null,
      quoteIssue: existing?.quoteIssue ?? null,
      lastReportedPrice: existing?.lastReportedPrice ?? null,
      returnIntegrity: existing?.returnIntegrity ?? {},
      returnAsOfDate: existing?.returnAsOfDate ?? null,
      return1MStartDate: existing?.return1MStartDate ?? null,
      return1YStartDate: existing?.return1YStartDate ?? null,
    };
  });
}

export function updateRowsForCollection(
  rowsByCollection: SectorRowsByCollection,
  collectionId: SectorCollectionId,
  items: readonly SectorDef[],
  updater: (rows: SectorRow[]) => SectorRow[],
): SectorRowsByCollection {
  return {
    ...rowsByCollection,
    [collectionId]: updater(normalizeRowsForCollection(rowsByCollection, collectionId, items)),
  };
}

function getSortedHistory(history: readonly PricePoint[]): Array<{ point: PricePoint; timestamp: number }> {
  // Later responses may correct a cached observation. Keep the last report at
  // each timestamp, including invalid closes, so they cannot expose an older one.
  const byTimestamp = new Map<number, PricePoint>();
  for (const point of history) {
    const timestamp = getPricePointTimestamp(point);
    if (Number.isFinite(timestamp)) byTimestamp.set(timestamp, point);
  }
  return [...byTimestamp].map(([timestamp, point]) => ({ point, timestamp }))
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function latestHistoryClose(history: readonly PricePoint[]): number | null {
  const point = getSortedHistory(history).at(-1)?.point;
  return point && !pricePointIntegrity(point) && Number.isFinite(point.close) && point.close > 0 ? point.close : null;
}

export function latestHistoryDate(history: readonly PricePoint[]): string | null {
  const latest = getSortedHistory(history).at(-1);
  return latest ? new Date(latest.timestamp).toISOString().slice(0, 10) : null;
}

export type SectorReturnRange = "1M" | "1Y";

/** Clamp calendar subtraction so March 31 maps to February's final day. */
export function sectorReturnTargetDate(asOfDate: string, range: SectorReturnRange): string {
  const shifted = new Date(`${asOfDate}T00:00:00Z`);
  const day = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() - (range === "1M" ? 1 : 12));
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return shifted.toISOString().slice(0, 10);
}

export function computeTrailingReturn(
  history: readonly PricePoint[],
  range: SectorReturnRange,
  latestPrice?: number | null,
  asOfDate = latestHistoryDate(history),
): { value: number | null; startDate: string; endDate: string; integrity?: PriceHistoryIntegrity } | null {
  if (!asOfDate) return null;
  const points = getSortedHistory(history);
  const target = sectorReturnTargetDate(asOfDate, range);
  // Use the last close on/before the calendar boundary, allowing a weekend or
  // exchange holiday. A shorter history or a long source gap is not 1M/1Y.
  const baseline = points.findLast(({ timestamp }) => new Date(timestamp).toISOString().slice(0, 10) <= target);
  if (!baseline) return null;
  const startDate = new Date(baseline.timestamp).toISOString().slice(0, 10);
  if (Date.parse(target) - Date.parse(startDate) > 7 * DAY_MS) return null;
  const end = points.findLast(({ timestamp }) => new Date(timestamp).toISOString().slice(0, 10) === asOfDate);
  const integrity = [pricePointIntegrity(baseline.point), end && pricePointIntegrity(end.point)]
    .filter((entry): entry is PriceHistoryIntegrity => !!entry);
  if (integrity.length > 0) return {
    value: null, startDate, endDate: asOfDate, integrity: mergePriceHistoryIntegrity(...integrity),
  };
  const endPrice = latestPrice != null && Number.isFinite(latestPrice) && latestPrice > 0
    ? latestPrice
    : end?.point.close;
  if (endPrice == null || !Number.isFinite(endPrice) || endPrice <= 0
    || !Number.isFinite(baseline.point.close) || baseline.point.close <= 0) return null;
  const value = (endPrice / baseline.point.close - 1) * 100;
  return Number.isFinite(value) ? { value, startDate, endDate: asOfDate } : null;
}

export function sectorRowIssues(row: SectorRow): string[] {
  const issues: string[] = [];
  if (row.quoteIssue) issues.push(row.quoteIssue);
  else if (row.quoteUnavailable) issues.push("quote unavailable");
  for (const range of ["1M", "1Y"] as const) {
    if (row.returnIntegrity?.[range]) issues.push(`${range}: inconsistent OHLC at return endpoint`);
    else if (row[range === "1M" ? "return1M" : "return1Y"] == null) issues.push(`${range}: history does not cover the shared window`);
  }
  return issues;
}

export function buildSectorColumns(width: number): SectorColumn[] {
  const etfWidth = 4;
  const priceWidth = 8;
  const changeWidth = 8;
  const returnWidth = 8;
  const showBar = width >= 67;
  const compactBar = width < 82;
  const barWidth = showBar
    ? compactBar ? 6 : Math.max(8, Math.min(18, Math.floor(width * 0.16)))
    : 0;
  const columnCount = showBar ? 7 : 6;
  const fixedWidth = etfWidth + priceWidth + changeWidth + returnWidth * 2 + barWidth;
  const nameWidth = Math.max(10, Math.min(22, width - 2 - columnCount - fixedWidth));

  const columns: SectorColumn[] = [
    { id: "name", label: "SECTOR", width: nameWidth, align: "left", flexGrow: 1 },
    { id: "etf", label: "ETF", width: etfWidth, align: "left" },
    { id: "price", label: "LAST", width: priceWidth, align: "right" },
    { id: "changePercent", label: "1D", width: changeWidth, align: "right" },
    { id: "return1M", label: "1M", width: returnWidth, align: "right" },
    { id: "return1Y", label: "1Y", width: returnWidth, align: "right" },
  ];
  if (showBar) {
    // Labelled with the window it encodes: it sits after 1Y but tracks 1D.
    columns.push({ id: "bar", label: "1D MOVE", width: barWidth, align: "left" });
  }
  return columns;
}

function getSortValue(columnId: SectorColumnId, row: SectorRow): string | number | null {
  switch (columnId) {
    case "name":
      return row.name;
    case "etf":
      return row.etf;
    case "price":
      return row.price;
    case "changePercent":
      return row.changePercent;
    case "return1M":
      return row.return1M;
    case "return1Y":
      return row.return1Y;
    case "bar":
      return row.changePercent;
  }
}

export function sortRows(rows: SectorRow[], sortPreference: SectorSortPreference): SectorRow[] {
  return [...rows].sort((left, right) => compareSortValues(
    getSortValue(sortPreference.columnId, left),
    getSortValue(sortPreference.columnId, right),
    sortPreference.direction,
  ));
}

export function nextSortPreference(current: SectorSortPreference, columnId: string): SectorSortPreference {
  const typedColumnId = columnId as SectorColumnId;
  if (current.columnId !== typedColumnId) {
    return {
      columnId: typedColumnId,
      direction: typedColumnId === "changePercent"
        || typedColumnId === "return1M"
        || typedColumnId === "return1Y"
        || typedColumnId === "bar"
        ? "desc"
        : "asc",
    };
  }
  if (current.direction === "desc") {
    return { columnId: typedColumnId, direction: "asc" };
  }
  return DEFAULT_SORT_PREFERENCE;
}
