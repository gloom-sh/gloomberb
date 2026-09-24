import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { overlayScreenerQuoteEntries } from "../shared/screener-live-quotes";
import type { Quote } from "../../../types/financials";
import type { QueryEntry } from "../../../market-data/result-types";
import { formatNumber } from "../../../utils/format";
import { formatMarketPriceWithCurrency, stablePriceFractionDigits } from "../../../market-data/market/format";
import type { DataTableColumn } from "../../../components";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { MARKET_SUMMARY_SYMBOLS, convertScreenerPriceUnit, screenerNumber, screenerVolume, screenerVolumeRatio, type MarketSummaryQuote, type ScreenerCategory, type ScreenerQuote } from "./screener";

export type TabId = "gainers" | "losers" | "actives" | "trending";

export const TABS: Array<{ id: TabId; label: string }> = [
  { id: "gainers", label: "Gainers" },
  { id: "losers", label: "Losers" },
  { id: "actives", label: "Most Active" },
  { id: "trending", label: "Trending" },
];

export const CATEGORY_MAP: Record<Exclude<TabId, "trending">, ScreenerCategory> = {
  gainers: "day_gainers",
  losers: "day_losers",
  actives: "most_actives",
};

type MarketMoverColumnId =
  | "rank"
  | "symbol"
  | "name"
  | "price"
  | "changePercent"
  | "volume"
  | "volumeRatio"
  | "range"
  | "marketCap";
export type MarketMoverColumn = DataTableColumn & { id: MarketMoverColumnId };
export type MarketMoverRow = ScreenerQuote & { rank: number };

export interface MarketMoverSortPreference {
  columnId: MarketMoverColumnId | null;
  direction: SortDirection;
}

export const DEFAULT_SORT_PREFERENCE: MarketMoverSortPreference = {
  columnId: null,
  direction: "asc",
};

/** The saved list selection, falling back to every list when it is unusable. */
export function resolveTabs(saved?: readonly string[]): Array<{ id: TabId; label: string }> {
  const byId = new Map(TABS.map((tab) => [tab.id as string, tab]));
  const resolved = (saved ?? [])
    .map((id) => byId.get(id))
    .filter((tab): tab is { id: TabId; label: string } => !!tab);
  return resolved.length > 0 ? resolved : [...TABS];
}

/** The saved index-summary selection, falling back to every index. */
export function resolveSummarySymbols(saved?: readonly string[]): string[] {
  const resolved = (saved ?? []).filter((symbol) => MARKET_SUMMARY_SYMBOLS.includes(symbol as never));
  return resolved.length > 0 ? resolved : [...MARKET_SUMMARY_SYMBOLS];
}

export const INDEX_SHORT: Record<string, string> = {
  "^GSPC": "SPX",
  "^DJI": "DJIA",
  "^IXIC": "COMP",
  "^RUT": "RUT",
};

export function fiftyTwoWeekPositionPercent(price: number | null, low: number | undefined, high: number | undefined): number | null {
  if (price == null || !Number.isFinite(price) || low == null || high == null || !Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null;
  return ((price - low) / (high - low)) * 100;
}

function getSortValue(
  columnId: MarketMoverColumnId,
  row: MarketMoverRow,
): string | number | null {
  switch (columnId) {
    case "rank":
      return row.rank;
    case "symbol":
      return row.symbol;
    case "name":
      return row.name;
    case "price":
      return row.price;
    case "changePercent":
      return row.changePercent;
    case "volume":
      return row.volume;
    case "volumeRatio":
      return row.volumeRatio;
    case "range":
      return fiftyTwoWeekPositionPercent(row.price, row.fiftyTwoWeekLow, row.fiftyTwoWeekHigh);
    case "marketCap":
      return row.marketCap ?? null;
  }
}

export function sortRows(
  rows: MarketMoverRow[],
  sortPreference: MarketMoverSortPreference,
): MarketMoverRow[] {
  const sortColumnId = sortPreference.columnId;
  if (!sortColumnId) return rows;
  return [...rows].sort((left, right) => compareSortValues(
    getSortValue(sortColumnId, left),
    getSortValue(sortColumnId, right),
    sortPreference.direction,
  ));
}

export function nextSortPreference(
  current: MarketMoverSortPreference,
  columnId: string,
): MarketMoverSortPreference {
  const typedColumnId = columnId as MarketMoverColumnId;
  if (current.columnId !== typedColumnId) {
    return { columnId: typedColumnId, direction: "asc" };
  }
  if (current.direction === "asc") {
    return { columnId: typedColumnId, direction: "desc" };
  }
  return DEFAULT_SORT_PREFERENCE;
}

/** A row is rebuilt only when its quote or rank moved, so unchanged rows skip the render. */
const moverRows = new WeakMap<ScreenerQuote, MarketMoverRow>();

export function createRows(quotes: ScreenerQuote[]): MarketMoverRow[] {
  return quotes.map((quote, index) => {
    const cached = moverRows.get(quote);
    if (cached?.rank === index + 1) return cached;
    const row = {
      ...quote,
      volumeRatio: screenerVolumeRatio(quote.volume, quote.avgVolume),
      rank: index + 1,
    };
    moverRows.set(quote, row);
    return row;
  });
}

export function summaryQuoteFromQuote(
  symbol: string,
  quote: { name?: string; price: number; change: number; changePercent: number },
): MarketSummaryQuote {
  return {
    symbol,
    name: quote.name ?? symbol,
    price: quote.price,
    change: quote.change,
    changePercent: quote.changePercent,
  };
}

export function screenerQuoteFromQuote(symbol: string, quote: { name?: string; price?: number; change?: number; changePercent?: number; volume?: number; currency?: string; exchangeName?: string; listingExchangeName?: string; lastUpdated?: number; previousClose?: number }): ScreenerQuote {
  return {
    symbol,
    name: quote.name ?? symbol,
    price: screenerNumber(quote.price),
    change: screenerNumber(quote.change),
    changePercent: screenerNumber(quote.changePercent),
    volume: screenerVolume(quote.volume),
    avgVolume: null,
    volumeRatio: null,
    marketCap: undefined,
    currency: quote.currency ?? "",
    fiftyTwoWeekHigh: undefined,
    fiftyTwoWeekLow: undefined,
    dayHigh: undefined,
    dayLow: undefined,
    exchange: quote.listingExchangeName ?? quote.exchangeName ?? "",
    lastUpdated: quote.lastUpdated,
    previousClose: screenerNumber(quote.previousClose) ?? undefined,
  };
}

/** The session-fixed price a mover's decimals are read from: its previous
 * close, else price less change (the same close), and only without either the
 * price itself. */
export function moverReferencePrice(row: Pick<ScreenerQuote, "price" | "change" | "previousClose">): number | undefined {
  if (row.previousClose != null && Number.isFinite(row.previousClose) && row.previousClose > 0) return row.previousClose;
  if (row.price == null) return undefined;
  // Rounded so float residue on a close of exactly $1 cannot flip the decimals between ticks.
  const close = row.change == null ? Number.NaN : Number((row.price - row.change).toPrecision(12));
  return Number.isFinite(close) && close > 0 ? close : row.price;
}

/** Listing currency at its minor unit (¥ none, $ two), four decimals under one
 * unit and a sub-cent coin's digits. A missing listing currency cannot be
 * represented by a USD symbol. The decimals come from `referencePrice`, so a
 * streamed tick landing on $0.50 or crossing $1 keeps the column's digits. */
export function formatMoverPrice(price: number | null, currency: string, referencePrice: number | null | undefined = price): string {
  if (!currency) return formatNumber(price ?? undefined);
  const unit = resolveCurrencyUnit(currency);
  const reference = referencePrice == null ? undefined : referencePrice / unit.divisor;
  // Movers are priced as stocks: the currency's minor unit, not a fixed two, sets the digits above one unit.
  const fixedFractionDigits = stablePriceFractionDigits({ assetCategory: "EQUITY", currency: unit.currency, referencePrice: reference });
  return formatMarketPriceWithCurrency(price == null ? undefined : price / unit.divisor, unit.currency,
    { fixedFractionDigits, referencePrice: reference });
}

/** Keyed by the overlaid row, which the shared overlay keeps while its quote holds. */
const convertedOverlays = new WeakMap<ScreenerQuote, ScreenerQuote>();

/** Range endpoints and the previous close belong to the original screener price denomination. */
export function overlayMarketMoverQuotes(
  rows: readonly ScreenerQuote[],
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
): ScreenerQuote[] {
  return overlayScreenerQuoteEntries(rows, entries).map((row, index) => {
    const original = rows[index]!;
    if (row === original) return row;
    const cached = convertedOverlays.get(row);
    if (cached) return cached;
    const convert = (value: number | undefined) => convertScreenerPriceUnit(value, original.currency, row.currency);
    const converted = {
      ...row,
      fiftyTwoWeekLow: convert(original.fiftyTwoWeekLow),
      fiftyTwoWeekHigh: convert(original.fiftyTwoWeekHigh),
      dayLow: convert(original.dayLow),
      dayHigh: convert(original.dayHigh),
      previousClose: row.previousClose ?? convert(original.previousClose),
    };
    convertedOverlays.set(row, converted);
    return converted;
  });
}
