import type { CryptoAssetKind, CryptoMarketAsset } from "../../../api-client/crypto-markets";
import type { DataTableColumn } from "../../../components";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QueryEntry } from "../../../market-data/result-types";
import type { PricePoint, Quote } from "../../../types/financials";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";

const DAY_MS = 86_400_000;

export const CRYPTO_TABS: Array<{ value: CryptoAssetKind; label: string }> = [
  { value: "coin", label: "Coins" },
  { value: "stablecoin", label: "Stablecoins" },
];

export interface CryptoRow {
  asset: CryptoMarketAsset;
  id: string;
  rank: number;
  code: string;
  name: string;
  price: number;
  /** The price as the board prints it. */
  priceText: string;
  changePercent: number | null;
  return7d: number | null;
  return30d: number | null;
  return1y: number | null;
  volume24h: number | null;
  marketCap: number | null;
  /** 30 completed daily closes with the live price appended. */
  history: PricePoint[];
  /** Epoch ms of the price shown. */
  updatedAt: number | null;
  live: boolean;
}

export const cryptoQuoteKey = (asset: Pick<CryptoMarketAsset, "symbol">) =>
  buildQuoteKey({ symbol: asset.symbol, exchange: "CCC" });

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

const utcDay = (ms: number) => Math.floor(ms / DAY_MS);

/** The close `days` UTC days before today, the basis the day change also uses. */
export function closeDaysAgo(asset: CryptoMarketAsset, days: number, now: number): number | null {
  const history = asset.history;
  if (!history) return null;
  const index = utcDay(now) - days - utcDay(Date.parse(`${history.start}T00:00:00Z`));
  const close = index >= 0 ? history.closes[index] : null;
  return finite(close) && close > 0 ? close : null;
}

const percentChange = (price: number, reference: number | null) =>
  reference != null && reference > 0 ? (price / reference - 1) * 100 : null;

/** A live quote replaces the board's snapshot once it is at least as new. */
export function liveQuote(
  asset: CryptoMarketAsset,
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
): Quote | null {
  const quote = resolveEntryData(entries.get(cryptoQuoteKey(asset)));
  if (!quote || !finite(quote.price) || quote.price <= 0) return null;
  const snapshotAt = asset.quoteTime ? Date.parse(asset.quoteTime) : null;
  if (snapshotAt != null && finite(quote.lastUpdated) && quote.lastUpdated < snapshotAt) return null;
  return quote;
}

/** The completed daily closes depend only on the board snapshot, so each asset builds them once. */
const closesByAsset = new WeakMap<CryptoMarketAsset, PricePoint[]>();

function completedCloses(asset: CryptoMarketAsset): PricePoint[] {
  const cached = closesByAsset.get(asset);
  if (cached) return cached;
  const start = asset.history ? Date.parse(`${asset.history.start}T00:00:00Z`) : 0;
  const closes: PricePoint[] = (asset.history?.closes ?? []).flatMap((close, index) =>
    close == null ? [] : [{ date: new Date(start + index * DAY_MS), close }]);
  closesByAsset.set(asset, closes);
  return closes;
}

export function buildCryptoRow(
  asset: CryptoMarketAsset,
  quote: Quote | null,
  now = Date.now(),
): CryptoRow {
  const price = quote?.price ?? asset.price;
  const changePercent = quote && finite(quote.changePercent)
    ? quote.changePercent
    : quote
      ? percentChange(price, asset.previousClose)
      : asset.changePercent;
  // Supply moves slowly; the price is what makes market cap live. Scaling the
  // reported cap keeps the source's supply basis and the board's ranking.
  const marketCap = finite(asset.marketCap)
    ? asset.marketCap * (price / asset.price)
    : finite(asset.circulatingSupply) && asset.circulatingSupply > 0 ? asset.circulatingSupply * price : null;
  const start = asset.history ? Date.parse(`${asset.history.start}T00:00:00Z`) : 0;
  const closes = completedCloses(asset);
  const history: PricePoint[] = closes.length
    ? [...closes, { date: new Date(Math.max(now, start + closes.length * DAY_MS)), close: price }]
    : closes;
  const updatedAt = quote?.lastUpdated ?? (asset.quoteTime ? Date.parse(asset.quoteTime) : null);
  return {
    asset,
    id: asset.symbol,
    rank: asset.rank,
    code: asset.code,
    name: asset.name,
    price,
    priceText: formatCryptoPrice(price, asset.kind === "stablecoin" ? 4 : 2),
    changePercent,
    return7d: percentChange(price, closeDaysAgo(asset, 7, now)),
    return30d: percentChange(price, closeDaysAgo(asset, 30, now)),
    return1y: percentChange(price, asset.yearAgoPrice),
    volume24h: asset.volume24h,
    marketCap,
    history,
    updatedAt: finite(updatedAt) ? updatedAt : null,
    live: !!quote && quote.delivery === "stream" && quote.stale !== true,
  };
}

const rowsByAsset = new WeakMap<CryptoMarketAsset, { quote: Quote | null; day: number; row: CryptoRow }>();

export function buildCryptoRows(
  assets: readonly CryptoMarketAsset[],
  kind: CryptoAssetKind,
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
  now = Date.now(),
): CryptoRow[] {
  const day = utcDay(now);
  return assets
    .filter((asset) => asset.kind === kind)
    .map((asset) => {
      // Returns move by UTC day and the price by quote, so a row whose asset,
      // quote and day all held is reused and its table row skips the render.
      const quote = liveQuote(asset, entries);
      const cached = rowsByAsset.get(asset);
      if (cached && cached.quote === quote && cached.day === day) return cached.row;
      const row = buildCryptoRow(asset, quote, now);
      rowsByAsset.set(asset, { quote, day, row });
      return row;
    });
}

/**
 * Four significant digits and never fewer than two decimals, with trailing
 * zeros kept, so a column running from 84,399.24 to 0.000005660 reads evenly.
 * Stablecoins ask for four decimals so 1.0001 and 0.9998 show the same peg detail.
 */
export function formatCryptoPrice(value: number | null, minimumDecimals = 2): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  const magnitude = Math.floor(Math.log10(value));
  const decimals = Math.min(12, Math.max(minimumDecimals, 3 - magnitude));
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatCryptoPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const text = value.toFixed(2);
  // A move that rounds to zero carries no sign.
  if (Number(text) === 0) return "0.00%";
  return `${value > 0 ? "+" : ""}${text}%`;
}

// Sorting ---------------------------------------------------------------------

export type CryptoColumnId =
  | "rank"
  | "code"
  | "name"
  | "price"
  | "changePercent"
  | "return7d"
  | "return30d"
  | "return1y"
  | "trend"
  | "volume24h"
  | "marketCap";

export type CryptoColumn = DataTableColumn & { id: CryptoColumnId };

export interface CryptoSortPreference {
  columnId: CryptoColumnId | null;
  direction: SortDirection;
}

export const DEFAULT_CRYPTO_SORT: CryptoSortPreference = { columnId: null, direction: "asc" };

const TEXT_COLUMNS = new Set<CryptoColumnId>(["rank", "code", "name"]);

/** Numbers open largest-first (top gainers, biggest caps); names open A-Z. */
export function nextCryptoSort(current: CryptoSortPreference, columnId: string): CryptoSortPreference {
  const id = columnId as CryptoColumnId;
  if (id === "trend") return current;
  const first: SortDirection = TEXT_COLUMNS.has(id) ? "asc" : "desc";
  if (current.columnId !== id) return { columnId: id, direction: first };
  if (current.direction === first) return { columnId: id, direction: first === "asc" ? "desc" : "asc" };
  return DEFAULT_CRYPTO_SORT;
}

export function sortCryptoRows(rows: CryptoRow[], sort: CryptoSortPreference): CryptoRow[] {
  const columnId = sort.columnId;
  if (!columnId || columnId === "trend") return rows;
  return [...rows].sort((left, right) => compareSortValues(left[columnId], right[columnId], sort.direction));
}

// Columns ---------------------------------------------------------------------

const COLUMN_SPECS: Array<CryptoColumn & { optional?: number }> = [
  { id: "rank", label: "#", width: 3, align: "right" },
  { id: "code", label: "COIN", width: 7, align: "left" },
  { id: "name", label: "NAME", width: 10, align: "left", optional: 1 },
  { id: "price", label: "PRICE", width: 13, align: "right" },
  { id: "changePercent", label: "CHG%", width: 8, align: "right" },
  { id: "return7d", label: "7D%", width: 8, align: "right" },
  { id: "return30d", label: "30D%", width: 8, align: "right", optional: 3 },
  { id: "return1y", label: "1Y%", width: 10, align: "right", optional: 5 },
  { id: "trend", label: "30D", width: 12, align: "left", optional: 4 },
  { id: "volume24h", label: "VOL 24H", width: 8, align: "right", optional: 2 },
  { id: "marketCap", label: "MCAP", width: 8, align: "right" },
];

const MAX_NAME_WIDTH = 24;

/**
 * Optional columns leave in a fixed order as the pane narrows (1Y, then the
 * sparkline, 30D, volume and the name); the name takes what width is left.
 */
export function buildCryptoColumns(width: number): CryptoColumn[] {
  const available = Math.max(0, width - 2);
  const optional = COLUMN_SPECS.flatMap((column) => column.optional ?? []).sort((a, b) => b - a);
  let dropped = new Set<number>();
  const fits = (columns: typeof COLUMN_SPECS) =>
    columns.reduce((sum, column) => sum + column.width + 1, 0) <= available;
  const visible = () => COLUMN_SPECS.filter((column) => !column.optional || !dropped.has(column.optional));
  for (const priority of optional) {
    if (fits(visible())) break;
    dropped = new Set([...dropped, priority]);
  }
  const columns = visible();
  const used = columns.reduce((sum, column) => sum + column.width + 1, 0);
  return columns.map(({ optional: _optional, ...column }) =>
    column.id === "name"
      ? { ...column, width: Math.min(MAX_NAME_WIDTH, column.width + Math.max(0, available - used)) }
      : column);
}
