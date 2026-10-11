import type { DataTableColumn } from "../../../components";
import { getTableWidth, tableColumnWidth } from "../../../components/ui/table-layout";
import type { PricePoint, Quote } from "../../../types/financials";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { getPricePointTimestamp } from "../../../utils/price-history";
import { mergePriceHistoryIntegrity, pricePointIntegrity, type PriceHistoryIntegrity } from "../../../utils/price-history-integrity";
import {
  getExtendedSessionDisplay,
  getRegularSessionDisplay,
  marketStateLabel,
  type ExtendedSession,
} from "../../../market-data/market/status";
import {
  getSectorCollection,
  type SectorCollectionId,
  type SectorDef,
} from "./sector-data";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_COLLECTION_ID: SectorCollectionId = "sectors";

/**
 * The pre-market or after-hours print beside a row's regular close, measured
 * from that close (getExtendedSessionDisplay); all null without one.
 */
export interface SectorExtendedFields {
  extendedSession?: ExtendedSession | null;
  extendedPrice?: number | null;
  extendedChange?: number | null;
  extendedChangePercent?: number | null;
}

export interface SectorRow extends SectorDef, SectorExtendedFields {
  /** The regular session's price: its close once it is over, never an extended print. */
  price: number | null;
  /** The regular session's move, as `ticker` reports it. */
  changePercent: number | null;
  return1M: number | null;
  return1Y: number | null;
  currency: string;
  loading: boolean;
  quoteUnavailable?: boolean;
  quoteSessionDate?: string | null;
  quoteIssue?: string | null;
  lastReportedPrice?: number | null;
  /** When the snapshot quote behind `price` was stamped; a live quote must be at least as new. */
  quoteUpdatedAt?: number | null;
  /** Whether that quote is real-time or delayed, for the report's freshness line. */
  quoteDataSource?: Quote["dataSource"];
  returnIntegrity?: Partial<Record<SectorReturnRange, PriceHistoryIntegrity>>;
  returnAsOfDate?: string | null;
  return1MStartDate?: string | null;
  return1YStartDate?: string | null;
}

type SectorColumnId = "name" | "etf" | "price" | "changePercent" | "preMarket" | "afterHours" | "return1M" | "return1Y" | "bar";
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

const NO_EXTENDED_PRINT: Required<SectorExtendedFields> = {
  extendedSession: null,
  extendedPrice: null,
  extendedChange: null,
  extendedChangePercent: null,
};

/** A quote's pre-market or after-hours print, from the regular close a row shows, as row fields. */
export function sectorExtendedFields(quote: Quote | null | undefined): Required<SectorExtendedFields> {
  const extended = getExtendedSessionDisplay(quote);
  if (!extended || !Number.isFinite(extended.price)) return NO_EXTENDED_PRINT;
  return {
    extendedSession: extended.session,
    extendedPrice: extended.price,
    extendedChange: Number.isFinite(extended.change) ? extended.change! : null,
    extendedChangePercent: Number.isFinite(extended.changePercent) ? extended.changePercent! : null,
  };
}

function extendedFieldsOf(row: SectorExtendedFields | undefined): Required<SectorExtendedFields> {
  return {
    extendedSession: row?.extendedSession ?? null,
    extendedPrice: row?.extendedPrice ?? null,
    extendedChange: row?.extendedChange ?? null,
    extendedChangePercent: row?.extendedChangePercent ?? null,
  };
}

function sameExtended(left: SectorExtendedFields, right: SectorExtendedFields): boolean {
  return (left.extendedSession ?? null) === (right.extendedSession ?? null)
    && (left.extendedPrice ?? null) === (right.extendedPrice ?? null)
    && (left.extendedChangePercent ?? null) === (right.extendedChangePercent ?? null);
}

/** The extended sessions some row has a print for, in the order their columns go. */
export function sectorExtendedSessions(rows: readonly SectorExtendedFields[]): ExtendedSession[] {
  return (["PRE", "POST"] as const).filter((session) => rows.some((row) => row.extendedSession === session));
}

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
      quoteUpdatedAt: existing?.quoteUpdatedAt ?? null,
      ...extendedFieldsOf(existing),
      returnIntegrity: existing?.returnIntegrity ?? {},
      returnAsOfDate: existing?.returnAsOfDate ?? null,
      return1MStartDate: existing?.return1MStartDate ?? null,
      return1YStartDate: existing?.return1YStartDate ?? null,
    };
  });
}

/**
 * Apply an update to one collection's rows. An updater that returns the rows
 * it was given leaves `rowsByCollection` itself, so the pane state is not
 * rewritten for a reload that changed nothing.
 */
export function updateRowsForCollection(
  rowsByCollection: SectorRowsByCollection,
  collectionId: SectorCollectionId,
  items: readonly SectorDef[],
  updater: (rows: SectorRow[]) => SectorRow[],
): SectorRowsByCollection {
  const rows = normalizeRowsForCollection(rowsByCollection, collectionId, items);
  const next = updater(rows);
  return next === rows ? rowsByCollection : { ...rowsByCollection, [collectionId]: next };
}

/** What a fund the reload could not load shows: no value is better than another session's. */
const UNAVAILABLE_SECTOR_ROW: Partial<SectorRow> = {
  price: null,
  changePercent: null,
  return1M: null,
  return1Y: null,
  returnAsOfDate: null,
  return1MStartDate: null,
  return1YStartDate: null,
  quoteUnavailable: true,
  quoteSessionDate: null,
  quoteIssue: "quote unavailable",
  lastReportedPrice: null,
  quoteUpdatedAt: null,
  returnIntegrity: {},
  ...NO_EXTENDED_PRINT,
};

function sameSectorRow(left: SectorRow, right: SectorRow): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as Array<keyof SectorRow>);
  for (const key of keys) {
    const a = left[key];
    const b = right[key];
    if (Object.is(a, b)) continue;
    if (a && b && typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b)) continue;
    return false;
  }
  return true;
}

/**
 * The rows after a reload. A full reload replaces every row and clears the
 * loading markers it set. A background reload leaves those markers alone,
 * keeps a fund it could not load on its last row while that row belongs to
 * the session the reload landed on, and returns `rows` itself when nothing
 * changed, so an idle board is neither rewritten nor re-rendered.
 */
export function applySectorReload(
  rows: SectorRow[],
  loaded: ReadonlyMap<string, Partial<SectorRow> | null>,
  background: boolean,
): SectorRow[] {
  if (!background) {
    return rows.map((row) => ({ ...row, ...(loaded.get(row.etf) ?? UNAVAILABLE_SECTOR_ROW), loading: false }));
  }
  const session = [...loaded.values()].find((row) => row?.returnAsOfDate)?.returnAsOfDate;
  if (!session) return rows;
  let changed = false;
  const next = rows.map((row) => {
    const fields = loaded.get(row.etf) ?? (row.returnAsOfDate === session ? null : UNAVAILABLE_SECTOR_ROW);
    if (!fields) return row;
    const merged = { ...row, ...fields, loading: row.loading };
    if (sameSectorRow(merged, row)) return row;
    changed = true;
    return merged;
  });
  return changed ? next : rows;
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

export function latestHistoryDate(history: readonly PricePoint[]): string | null {
  const latest = getSortedHistory(history).at(-1);
  return latest ? new Date(latest.timestamp).toISOString().slice(0, 10) : null;
}

/** The last daily session dated before `beforeDate`, with the close that anchors its change. */
export function historySessionBefore(history: readonly PricePoint[], beforeDate: string): { date: string; close: number; changePercent: number } | null {
  const points = getSortedHistory(history)
    .filter(({ timestamp }) => new Date(timestamp).toISOString().slice(0, 10) < beforeDate);
  const [previous, latest] = points.slice(-2);
  if (!previous || !latest || pricePointIntegrity(previous.point) || pricePointIntegrity(latest.point)) return null;
  const close = latest.point.close;
  const changePercent = (close / previous.point.close - 1) * 100;
  if (!(close > 0) || !(previous.point.close > 0) || !Number.isFinite(changePercent)) return null;
  return { date: new Date(latest.timestamp).toISOString().slice(0, 10), close, changePercent };
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

function returnBaseline(history: readonly PricePoint[], asOfDate: string, range: SectorReturnRange) {
  const target = sectorReturnTargetDate(asOfDate, range);
  const baseline = getSortedHistory(history).findLast(({ timestamp }) => new Date(timestamp).toISOString().slice(0, 10) <= target);
  if (!baseline) return null;
  const startDate = new Date(baseline.timestamp).toISOString().slice(0, 10);
  if (Date.parse(target) - Date.parse(startDate) > 7 * DAY_MS) return null;
  return { ...baseline, startDate };
}

/** A reported session establishes the calendar even when its price or the ending observation is unavailable. */
export function sectorReturnStartDate(history: readonly PricePoint[], range: SectorReturnRange, asOfDate: string | null): string | null {
  return asOfDate ? returnBaseline(history, asOfDate, range)?.startDate ?? null : null;
}

export function computeTrailingReturn(
  history: readonly PricePoint[],
  range: SectorReturnRange,
  latestPrice?: number | null,
  asOfDate = latestHistoryDate(history),
): { value: number | null; startDate: string; endDate: string; integrity?: PriceHistoryIntegrity } | null {
  if (!asOfDate) return null;
  const points = getSortedHistory(history);
  // Use the last close on/before the calendar boundary, allowing a weekend or
  // exchange holiday. A shorter history or a long source gap is not 1M/1Y.
  const baseline = returnBaseline(history, asOfDate, range);
  if (!baseline) return null;
  const { startDate } = baseline;
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

const EXTENDED_COLUMN_WIDTH = 9;
/** The longest name in either collection ("Consumer Staples"), which a narrow pane keeps whole as long as it can. */
const FULL_NAME_WIDTH = 16;

/**
 * The board's columns at `width`. A pre-market or after-hours column follows
 * 1D for each session in `extendedSessions`. A narrow pane gives up the move
 * bar first, then that column, before it cuts a sector's name.
 */
export function buildSectorColumns(width: number, extendedSessions: readonly ExtendedSession[] = []): SectorColumn[] {
  const lead: SectorColumn[] = [
    { id: "etf", label: "ETF", width: 4, align: "left" },
    { id: "price", label: "LAST", width: 8, align: "right" },
    { id: "changePercent", label: "1D", width: 8, align: "right" },
  ];
  const returns: SectorColumn[] = [
    { id: "return1M", label: "1M", width: 8, align: "right" },
    { id: "return1Y", label: "1Y", width: 8, align: "right" },
  ];
  const extendedColumns = extendedSessions.map((session): SectorColumn => ({
    id: session === "PRE" ? "preMarket" : "afterHours",
    // Named for the session it trades in, as the header labels it.
    label: marketStateLabel(session),
    width: EXTENDED_COLUMN_WIDTH,
    align: "right",
  }));
  // Measured the way the table draws them (a header and its sort mark widen a
  // column, gaps between them); the name adds its own width and a gap.
  const nameRoom = (columns: SectorColumn[]) => width - getTableWidth(columns) - 1;
  const shownExtended = extendedColumns.length > 0 && nameRoom([...lead, ...extendedColumns, ...returns]) >= FULL_NAME_WIDTH
    ? extendedColumns
    : [];
  const extendedWidth = shownExtended.reduce((total, column) => total + tableColumnWidth(column) + 1, 0);
  const barWidth = width - extendedWidth < 82 ? 6 : Math.max(8, Math.min(18, Math.floor(width * 0.16)));
  // Labelled with the window it encodes: it sits after 1Y but tracks 1D.
  const bar: SectorColumn = { id: "bar", label: "1D MOVE", width: barWidth, align: "left" };
  const withBar = [...lead, ...shownExtended, ...returns, bar];
  const showBar = width - extendedWidth >= 67 && nameRoom(withBar) >= FULL_NAME_WIDTH;
  const columns = showBar ? withBar : [...lead, ...shownExtended, ...returns];
  return [
    { id: "name", label: "SECTOR", width: Math.max(10, Math.min(22, nameRoom(columns))), align: "left", flexGrow: 1 },
    ...columns,
  ];
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
    case "preMarket":
    case "afterHours":
      return row.extendedSession === (columnId === "preMarket" ? "PRE" : "POST") ? row.extendedChangePercent ?? null : null;
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
        || typedColumnId === "preMarket"
        || typedColumnId === "afterHours"
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

const finitePositive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * The session a quote's regular price belongs to. Every instrument in these
 * collections is a US-listed ETF, so an undeclared session is the New York
 * date of the quote.
 */
export function sectorQuoteSessionDate(quote: Quote): string | null {
  const declared = quote.changeSessionDate;
  if (typeof declared === "string" && /^\d{4}-\d{2}-\d{2}$/.test(declared)
    && Number.isFinite(Date.parse(declared)) && new Date(declared).toISOString().slice(0, 10) === declared) return declared;
  if (declared != null) return null;
  if (!Number.isFinite(quote.lastUpdated) || quote.lastUpdated <= 0) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(quote.lastUpdated));
}

/**
 * A live quote extends a loaded row only inside the session its returns are
 * measured to. Every fund shares that session, so a pre-market print (the
 * next session) or a quote older than the snapshot leaves the row's price
 * alone and the board keeps ranking on one completed session. The 1M and 1Y
 * returns keep their baselines: the row's own return and price imply the
 * start close.
 */
function isLiveSectorQuote(row: SectorRow, quote: Quote | null | undefined): quote is Quote {
  if (!isCurrentSectorQuote(row, quote) || !finitePositive(getRegularSessionDisplay(quote)?.price)) return false;
  return sectorQuoteSessionDate(quote) === row.returnAsOfDate;
}

/** A usable quote no older than the snapshot behind a loaded row. */
function isCurrentSectorQuote(row: SectorRow, quote: Quote | null | undefined): quote is Quote {
  if (!quote || quote.stale === true) return false;
  if (!finitePositive(row.price) || !row.returnAsOfDate) return false;
  return row.quoteUpdatedAt == null || quote.lastUpdated >= row.quoteUpdatedAt;
}

/** A pre-market print of the session after the row's, which moves only the extended column. */
function isNextPreMarketQuote(row: SectorRow, quote: Quote): boolean {
  if (quote.marketState !== "PRE" && quote.marketState !== "PREPRE") return false;
  const session = sectorQuoteSessionDate(quote);
  return !!session && !!row.returnAsOfDate && session > row.returnAsOfDate;
}

/**
 * Whether the feed keeps a loaded row as current as a snapshot reload would,
 * given a quote the feed is carrying. It does when the quote belongs to the
 * row's session (the overlay extends it) or an older one (the fund has not
 * printed since), and for a pre-market print of the next session, which the
 * board leaves on the completed one until the open. A regular print of a
 * newer session is what rolls the board forward, and only a reload can. A
 * fund with no snapshot price is left to the research reload or a manual
 * one: the feed cannot extend it, so it must not hold the whole board on a
 * one-minute reload.
 */
export function sectorRowFollowsQuote(row: SectorRow, quote: Quote): boolean {
  if (!finitePositive(row.price) || !row.returnAsOfDate) return true;
  const session = sectorQuoteSessionDate(quote);
  if (!session || session <= row.returnAsOfDate) return true;
  return quote.marketState === "PRE" || quote.marketState === "PREPRE";
}

/**
 * A row with the feed's quote on it. Price and 1D are the regular session,
 * as `ticker` reads them, so they hold at the close; a pre-market or
 * after-hours print moves only the extended column, measured from that close.
 */
export function overlayLiveSectorQuote(row: SectorRow, quote: Quote | null | undefined): SectorRow {
  if (!isCurrentSectorQuote(row, quote) || row.price == null) return row;
  if (!isLiveSectorQuote(row, quote)) {
    if (!isNextPreMarketQuote(row, quote)) return row;
    const extended = sectorExtendedFields(quote);
    return sameExtended(extended, row) ? row : { ...row, ...extended };
  }
  const headline = getRegularSessionDisplay(quote)!;
  const extended = sectorExtendedFields(quote);
  const changePercent = Number.isFinite(headline.changePercent) ? headline.changePercent! : row.changePercent;
  if (headline.price === row.price && changePercent === row.changePercent && sameExtended(extended, row)) return row;
  const scale = headline.price / row.price;
  // A held close leaves the returns exactly as they were.
  const rescale = (value: number | null) => (value == null || scale === 1 ? value : ((1 + value / 100) * scale - 1) * 100);
  return {
    ...row,
    price: headline.price,
    lastReportedPrice: headline.price,
    changePercent,
    return1M: rescale(row.return1M),
    return1Y: rescale(row.return1Y),
    ...extended,
  };
}
