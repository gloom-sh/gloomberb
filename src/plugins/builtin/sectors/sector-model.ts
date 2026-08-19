import type { DataTableColumn } from "../../../components";
import type { PricePoint } from "../../../types/financials";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { getPricePointTimestamp } from "../../../utils/price-history";
import {
  getSectorCollection,
  type SectorCollectionId,
  type SectorDef,
} from "./sector-data";

const DAY_MS = 24 * 60 * 60 * 1000;
export const ONE_MONTH_DAYS = 30;
export const ONE_YEAR_DAYS = 365;
export const DEFAULT_COLLECTION_ID: SectorCollectionId = "sectors";

export interface SectorRow extends SectorDef {
  price: number | null;
  changePercent: number | null;
  return1M: number | null;
  return1Y: number | null;
  currency: string;
  loading: boolean;
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
  return history
    .map((point) => ({ point, timestamp: getPricePointTimestamp(point) }))
    .filter(({ point, timestamp }) => (
      Number.isFinite(timestamp)
      && Number.isFinite(point.close)
      && point.close > 0
    ))
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function latestHistoryClose(history: readonly PricePoint[]): number | null {
  return getSortedHistory(history).at(-1)?.point.close ?? null;
}

export function computeTrailingReturn(
  history: readonly PricePoint[],
  days: number,
  latestPrice?: number | null,
): number | null {
  const points = getSortedHistory(history);
  if (points.length < 2) return null;

  const latest = points.at(-1)!;
  const endPrice = latestPrice != null && Number.isFinite(latestPrice) && latestPrice > 0
    ? latestPrice
    : latest.point.close;
  const targetTimestamp = latest.timestamp - days * DAY_MS;
  let baseline = points[0]!;
  for (const point of points) {
    if (point.timestamp > targetTimestamp) break;
    baseline = point;
  }
  const baselinePrice = baseline.point.close;
  if (!Number.isFinite(endPrice) || !Number.isFinite(baselinePrice) || baselinePrice <= 0) return null;
  return (endPrice / baselinePrice - 1) * 100;
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
