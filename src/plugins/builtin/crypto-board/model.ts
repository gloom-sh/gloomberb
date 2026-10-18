import type { CryptoAssetKind, CryptoMarketAsset, CryptoPeg } from "../../../api-client/crypto-markets";
import type { DataTableColumn } from "../../../components";
import { getTableWidth } from "../../../components/ui/table-layout";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QueryEntry } from "../../../market-data/result-types";
import type { PricePoint, Quote } from "../../../types/financials";
import type { HeadlessPaneFreshness } from "../../../types/headless";
import { compareSortValues, nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { isFiniteNumber } from "../../../utils/guards";
import { formatBasisPoints, toBasisPoints } from "../../../utils/basis-points";
import { formatUtcWeekdayTime } from "../../../utils/utc-time";

const DAY_MS = 86_400_000;

/**
 * How the board's report, capture and footer date its prices: crypto trades around the clock, so a price an hour old
 * has stopped refreshing, and coins are quoted apart, so the line says how old the oldest is.
 */
export const CRYPTO_BOARD_FRESHNESS: HeadlessPaneFreshness = { maxAgeMinutes: 60, oldestAge: true };

export const CRYPTO_TABS: Array<{ value: CryptoAssetKind; label: string }> = [
  { value: "coin", label: "Coins" },
  { value: "stablecoin", label: "Stablecoins" },
];

/** A stablecoin's supply as its row shows it; every field is null on the coin tab and for a coin the supply list lacks. */
export interface CryptoRowSupply {
  /** USD. */
  supply: number | null;
  /** The change in USD over 7 and 30 days on the coin's daily supply, and in percent. */
  supply7d: number | null;
  supply7dPercent: number | null;
  supply30d: number | null;
  supply30dPercent: number | null;
  /** Percent of all stablecoin supply. */
  supplyShare: number | null;
  /** The coin's peg currency as the supply source names it (peggedUSD, peggedEUR). */
  pegType: string | null;
}

const NO_SUPPLY: CryptoRowSupply = {
  supply: null,
  supply7d: null,
  supply7dPercent: null,
  supply30d: null,
  supply30dPercent: null,
  supplyShare: null,
  pegType: null,
};

export interface CryptoRow extends CryptoRowSupply {
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
  /** A stablecoin's peg; null for a coin, or a server that does not send it. */
  peg: CryptoPeg | null;
  /** `USD`, `EUR 1.1242` (the target in dollars), `USD yield`; empty without a peg. */
  pegText: string;
  /** How far the price is off its target, in basis points; null when it accrues yield or the target is unknown. */
  offPegBp: number | null;
  /** The 24-hour low and high, the price shown included, and when each traded (epoch ms). */
  low24h: number | null;
  low24hAt: number | null;
  high24h: number | null;
  high24hAt: number | null;
  /** The low and high at the price's decimals. */
  low24hText: string;
  high24hText: string;
}

export const cryptoQuoteKey = (asset: Pick<CryptoMarketAsset, "symbol">) =>
  buildQuoteKey({ symbol: asset.symbol, exchange: "CCC" });

const positive = (value: number | null | undefined): value is number => isFiniteNumber(value) && value > 0;

const utcDay = (ms: number) => Math.floor(ms / DAY_MS);

/** The close `days` UTC days before today, the basis the day change also uses. */
function closeDaysAgo(asset: CryptoMarketAsset, days: number, now: number): number | null {
  const history = asset.history;
  if (!history) return null;
  const index = utcDay(now) - days - utcDay(Date.parse(`${history.start}T00:00:00Z`));
  const close = index >= 0 ? history.closes[index] : null;
  return isFiniteNumber(close) && close > 0 ? close : null;
}

const percentChange = (price: number, reference: number | null) =>
  reference != null && reference > 0 ? (price / reference - 1) * 100 : null;

/** A live quote replaces the board's snapshot once it is at least as new. */
function liveQuote(
  asset: CryptoMarketAsset,
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
): Quote | null {
  const quote = resolveEntryData(entries.get(cryptoQuoteKey(asset)));
  if (!quote || !isFiniteNumber(quote.price) || quote.price <= 0) return null;
  const snapshotAt = asset.quoteTime ? Date.parse(asset.quoteTime) : null;
  if (snapshotAt != null && isFiniteNumber(quote.lastUpdated) && quote.lastUpdated < snapshotAt) return null;
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

function buildCryptoRow(
  asset: CryptoMarketAsset,
  quote: Quote | null,
  now = Date.now(),
): CryptoRow {
  const price = quote?.price ?? asset.price;
  const changePercent = quote && isFiniteNumber(quote.changePercent)
    ? quote.changePercent
    : quote
      ? percentChange(price, asset.previousClose)
      : asset.changePercent;
  // Supply moves slowly; the price is what makes market cap live. Scaling the
  // reported cap keeps the source's supply basis and the board's ranking.
  const marketCap = isFiniteNumber(asset.marketCap)
    ? asset.marketCap * (price / asset.price)
    : isFiniteNumber(asset.circulatingSupply) && asset.circulatingSupply > 0 ? asset.circulatingSupply * price : null;
  const start = asset.history ? Date.parse(`${asset.history.start}T00:00:00Z`) : 0;
  const closes = completedCloses(asset);
  const prior = rowsByAsset.get(asset)?.row.history;
  const tail = prior && prior.length === closes.length + 1 ? prior.at(-1) : undefined;
  const history: PricePoint[] = !closes.length
    ? closes
    : tail && tail.close === price
      ? prior!
      : [...closes, { date: new Date(Math.max(now, start + closes.length * DAY_MS)), close: price }];
  const updatedAt = quote?.lastUpdated ?? (asset.quoteTime ? Date.parse(asset.quoteTime) : null);
  // The digits follow a price that holds still for the day, so a tick across a
  // power of ten (0.9998 to 1.0002) keeps the row's decimals.
  const referencePrice = [asset.previousClose, quote?.previousClose, quote?.open].find(positive) ?? asset.price;
  const peg = asset.kind === "stablecoin" ? asset.peg ?? null : null;
  const updated = isFiniteNumber(updatedAt) ? updatedAt : null;
  const minimumDecimals = asset.kind === "stablecoin" ? 4 : 2;
  const range = asset.kind === "stablecoin"
    ? dayRange(asset, price, updated)
    : { low24h: null, low24hAt: null, high24h: null, high24hAt: null };
  return {
    asset,
    id: asset.symbol,
    rank: asset.rank,
    code: asset.code,
    name: asset.name,
    price,
    priceText: formatCryptoPrice(price, minimumDecimals, referencePrice),
    changePercent,
    return7d: percentChange(price, closeDaysAgo(asset, 7, now)),
    return30d: percentChange(price, closeDaysAgo(asset, 30, now)),
    return1y: percentChange(price, asset.yearAgoPrice),
    volume24h: asset.volume24h,
    marketCap,
    history,
    updatedAt: updated,
    live: !!quote && quote.delivery === "stream" && quote.stale !== true,
    peg,
    pegText: formatPegTarget(peg),
    offPegBp: offPegBasisPoints(price, peg),
    ...range,
    low24hText: formatCryptoPrice(range.low24h, minimumDecimals, referencePrice),
    high24hText: formatCryptoPrice(range.high24h, minimumDecimals, referencePrice),
    ...NO_SUPPLY,
  };
}

/**
 * What a stablecoin's price is measured against: `USD`; a coin on another
 * currency by its target in dollars, `EUR 1.1242`, so EURC at 1.1234 does not
 * read as a 12% premium; a coin whose yield accrues into its price (USDY) is
 * marked so and has no par to be off.
 */
export function formatPegTarget(peg: CryptoPeg | null | undefined): string {
  if (!peg) return "";
  if (peg.accrues) return `${peg.currency} yield`;
  if (peg.currency === "USD") return "USD";
  return peg.price == null ? peg.currency : `${peg.currency} ${peg.price.toFixed(4)}`;
}

/** Basis points off the peg, to a tenth: (price / target - 1) x 10,000. Null when the coin accrues yield or the target is unknown. */
export function offPegBasisPoints(price: number, peg: CryptoPeg | null | undefined): number | null {
  if (!peg || peg.accrues || peg.price == null || !(peg.price > 0) || !(price > 0)) return null;
  return toBasisPoints((price / peg.price - 1) * 100, 1);
}

/** `-12.9bp`; a coin on its peg reads `0.0bp`; blank when there is no par to be off. */
export function formatOffPeg(bp: number | null): string {
  return bp == null ? "" : formatBasisPoints(bp / 100, 1);
}

/** Off by this many basis points either way a stablecoin is worth a look; by a percent it has lost its peg. */
const OFF_PEG_WATCH_BP = 25;
const OFF_PEG_BROKEN_BP = 100;

export function offPegSeverity(bp: number | null): "none" | "watch" | "broken" {
  if (bp == null) return "none";
  const size = Math.abs(bp);
  return size >= OFF_PEG_BROKEN_BP ? "broken" : size >= OFF_PEG_WATCH_BP ? "watch" : "none";
}

/**
 * The 24-hour low and high the board reported, widened by a newer price than
 * it had seen, so a live tick below the low is the low, at its time.
 */
function dayRange(asset: CryptoMarketAsset, price: number, updatedAt: number | null) {
  const range = asset.range24h;
  if (!range) return { low24h: null, low24hAt: null, high24h: null, high24hAt: null };
  let low24h = range.low;
  let low24hAt: number | null = Date.parse(range.lowAt);
  let high24h = range.high;
  let high24hAt: number | null = Date.parse(range.highAt);
  const newer = updatedAt != null && updatedAt > Date.parse(range.end);
  if (newer && price < low24h) [low24h, low24hAt] = [price, updatedAt];
  if (newer && price > high24h) [high24h, high24hAt] = [price, updatedAt];
  return {
    low24h,
    low24hAt: isFiniteNumber(low24hAt) ? low24hAt : null,
    high24h,
    high24hAt: isFiniteNumber(high24hAt) ? high24hAt : null,
  };
}

/** `Sat 11:30` UTC; a dash when unknown. */
export function formatDayRangeTime(ms: number | null): string {
  return ms == null ? "—" : formatUtcWeekdayTime(ms) || "—";
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

const suppliedRows = new WeakMap<CryptoRow, { supply: CryptoRowSupply; row: CryptoRow }>();

/**
 * Each row with its coin's supply, matched by code. A row keeps its identity
 * while its price and its supply hold, so the table still skips it.
 */
export function withCryptoSupply(rows: readonly CryptoRow[], supply: ReadonlyMap<string, CryptoRowSupply>): CryptoRow[] {
  if (supply.size === 0) return rows as CryptoRow[];
  return rows.map((row) => {
    const own = supply.get(row.code.toUpperCase());
    if (!own) return row;
    const cached = suppliedRows.get(row);
    if (cached && cached.supply === own) return cached.row;
    const supplied = { ...row, ...own };
    suppliedRows.set(row, { supply: own, row: supplied });
    return supplied;
  });
}

/** What a capture and the footer read of each row: when its price is from, and whether it is streaming live. */
export function cryptoRowObservations(rows: readonly CryptoRow[]): Array<{ quoteTime: string; dataSource: "live" | "delayed" }> {
  return rows.flatMap((row) => row.updatedAt == null ? [] : [{ quoteTime: new Date(row.updatedAt).toISOString(), dataSource: row.live ? "live" as const : "delayed" as const }]);
}

/**
 * Four significant digits and never fewer than two decimals, with trailing
 * zeros kept, so a column running from 84,399.24 to 0.000005660 reads evenly.
 * Stablecoins ask for four decimals so 1.0001 and 0.9998 show the same peg detail.
 * The digits are counted at `referencePrice` (a session-fixed price such as the
 * previous close) when there is one, so a live price crossing a power of ten
 * keeps its decimals.
 */
export function formatCryptoPrice(value: number | null, minimumDecimals = 2, referencePrice?: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  const magnitude = Math.floor(Math.log10(positive(referencePrice) ? referencePrice : value));
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

type CryptoColumnId =
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
  | "marketCap"
  | "pegText"
  | "offPegBp"
  | "low24h"
  | "low24hAt"
  | "high24h"
  | "high24hAt"
  | "supply"
  | "supply7dPercent"
  | "supply7d"
  | "supply30dPercent"
  | "supply30d"
  | "supplyShare";

export type CryptoColumn = DataTableColumn & { id: CryptoColumnId };

export interface CryptoSortPreference {
  columnId: CryptoColumnId | null;
  direction: SortDirection;
}

export const DEFAULT_CRYPTO_SORT: CryptoSortPreference = { columnId: null, direction: "asc" };

const TEXT_COLUMNS = new Set<CryptoColumnId>(["rank", "code", "name", "pegText"]);

/** Numbers open largest-first (top gainers, biggest caps); names open A-Z. */
export function nextCryptoSort(current: CryptoSortPreference, columnId: string): CryptoSortPreference {
  const id = columnId as CryptoColumnId;
  if (id === "trend") return current;
  return nextHeaderSort(current, id, {
    firstDirection: TEXT_COLUMNS.has(id) ? "asc" : "desc",
    resetTo: DEFAULT_CRYPTO_SORT,
  });
}

/** Off peg sorts by size, so the first click puts the furthest from its peg on top, above or below it. */
function sortValue(row: CryptoRow, columnId: Exclude<CryptoColumnId, "trend">) {
  return columnId === "offPegBp" ? row.offPegBp == null ? null : Math.abs(row.offPegBp) : row[columnId];
}

export function sortCryptoRows(rows: CryptoRow[], sort: CryptoSortPreference): CryptoRow[] {
  const columnId = sort.columnId;
  if (!columnId || columnId === "trend") return rows;
  return [...rows].sort((left, right) => compareSortValues(sortValue(left, columnId), sortValue(right, columnId), sort.direction));
}

// Columns ---------------------------------------------------------------------

type CryptoColumnSpec = CryptoColumn & { optional?: number };

const COLUMN_SPECS: CryptoColumnSpec[] = [
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

/**
 * A stablecoin is read by its peg: what it holds to, how far off it is, and
 * the 24-hour low and high with their times, before its returns. Narrowing,
 * the returns, the sparkline and the day change leave first, then volume, the
 * name and the high; the peg, the low and when it traded stay.
 */
const STABLECOIN_COLUMN_SPECS: CryptoColumnSpec[] = [
  { id: "rank", label: "#", width: 3, align: "right" },
  { id: "code", label: "COIN", width: 7, align: "left" },
  { id: "name", label: "NAME", width: 10, align: "left", optional: 3 },
  { id: "price", label: "PRICE", width: 8, align: "right" },
  { id: "pegText", label: "PEG", width: 10, align: "left" },
  { id: "offPegBp", label: "OFF PEG", width: 8, align: "right" },
  { id: "low24h", label: "24H LOW", width: 8, align: "right" },
  { id: "low24hAt", label: "LOW UTC", width: 9, align: "left" },
  { id: "high24h", label: "24H HIGH", width: 8, align: "right", optional: 1 },
  { id: "high24hAt", label: "HIGH UTC", width: 9, align: "left", optional: 2 },
  { id: "changePercent", label: "CHG%", width: 8, align: "right", optional: 5 },
  { id: "return7d", label: "7D%", width: 8, align: "right", optional: 6 },
  { id: "return30d", label: "30D%", width: 8, align: "right", optional: 8 },
  { id: "return1y", label: "1Y%", width: 10, align: "right", optional: 9 },
  { id: "trend", label: "30D", width: 12, align: "left", optional: 7 },
  { id: "volume24h", label: "VOL 24H", width: 8, align: "right", optional: 4 },
  { id: "marketCap", label: "MCAP", width: 8, align: "right" },
];

/**
 * With supply loaded, each coin's supply follows the market cap. Every supply
 * column leaves before the name, so the peg columns narrow as they do without
 * supply: the dollar changes go with the price returns, then (after volume)
 * share, the 30D and 7D change and supply itself.
 */
const STABLECOIN_SUPPLY_COLUMN_SPECS: CryptoColumnSpec[] = [
  ...STABLECOIN_COLUMN_SPECS,
  { id: "supply", label: "SUPPLY", width: 8, align: "right", optional: 3.2 },
  { id: "supply7dPercent", label: "SUP 7D%", width: 8, align: "right", optional: 3.4 },
  { id: "supply7d", label: "SUP 7D", width: 8, align: "right", optional: 4.6 },
  { id: "supply30dPercent", label: "SUP 30D%", width: 8, align: "right", optional: 3.6 },
  { id: "supply30d", label: "SUP 30D", width: 8, align: "right", optional: 4.8 },
  { id: "supplyShare", label: "SHARE", width: 7, align: "right", optional: 3.8 },
];

const MAX_NAME_WIDTH = 24;

/**
 * Optional columns leave in a fixed order as the pane narrows (1Y, then the
 * sparkline, 30D, volume and the name); the name takes what width is left.
 * The stablecoin tab adds the supply columns only `withSupply`, so a supply
 * outage leaves the price columns as they are.
 */
export function buildCryptoColumns(width: number, kind: CryptoAssetKind = "coin", withSupply = false): CryptoColumn[] {
  const specs = kind !== "stablecoin" ? COLUMN_SPECS : withSupply ? STABLECOIN_SUPPLY_COLUMN_SPECS : STABLECOIN_COLUMN_SPECS;
  const optional = specs.flatMap((column) => column.optional ?? []).sort((a, b) => b - a);
  let dropped = new Set<number>();
  // Measured the way the table draws them (header floors, gaps, padding and the
  // extra gutter after a right-aligned column), so the last column never clips.
  const fits = (columns: typeof specs) => getTableWidth(columns) <= width;
  const visible = () => specs.filter((column) => !column.optional || !dropped.has(column.optional));
  for (const priority of optional) {
    if (fits(visible())) break;
    dropped = new Set([...dropped, priority]);
  }
  const columns = visible();
  const spare = Math.max(0, width - getTableWidth(columns));
  return columns.map(({ optional: _optional, ...column }) =>
    column.id === "name"
      ? { ...column, width: Math.min(MAX_NAME_WIDTH, column.width + spare) }
      : column);
}
