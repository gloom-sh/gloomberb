import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { overlayScreenerQuoteEntries } from "../../../market-data/quotes/screener-live-quotes";
import {
  getExtendedSessionDisplay,
  getRegularSessionDisplay,
  type ExtendedSession,
  type ExtendedSessionDisplay,
} from "../../../market-data/market/status";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import { isFiniteNumber } from "../../../utils/guards";
import type { Quote } from "../../../types/financials";
import type { CloudSessionMoversCategory } from "../../../api-client/market-movers";
import type { QueryEntry } from "../../../market-data/result-types";
import { formatNumber } from "../../../utils/format";
import { formatMarketPriceWithCurrency, stablePriceFractionDigits } from "../../../market-data/market/format";
import type { DataTableColumn } from "../../../components";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { MARKET_SUMMARY_SYMBOLS, convertScreenerPriceUnit, screenerNumber, screenerVolume, screenerVolumeRatio, type MarketSummaryQuote, type ScreenerCategory, type ScreenerQuote } from "./screener";

/** Lists ranked from day screeners and trending symbols. */
export type ScreenerTabId = "gainers" | "losers" | "actives" | "trending";
/** Pre-market, after-hours and gap lists from the whole listed market. */
export type SessionTabId = CloudSessionMoversCategory;
export type TabId = ScreenerTabId | SessionTabId;

export const TABS: Array<{ id: TabId; label: string }> = [
  { id: "gainers", label: "Gainers" },
  { id: "losers", label: "Losers" },
  { id: "actives", label: "Most Active" },
  { id: "trending", label: "Trending" },
  { id: "premarket", label: "Pre-market" },
  { id: "afterhours", label: "After hours" },
  { id: "gaps", label: "Gaps" },
];

export const CATEGORY_MAP: Record<Exclude<ScreenerTabId, "trending">, ScreenerCategory> = {
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
  | "preMarket"
  | "afterHours"
  | "volume"
  | "volumeRatio"
  | "range"
  | "marketCap";
export type MarketMoverColumn = DataTableColumn & { id: MarketMoverColumnId };
/**
 * A list row. Price and change are the regular session's, as `ticker` reads
 * them; a row whose quote has a pre-market or after-hours print carries it in
 * `extended`, measured from that session's close.
 */
export type MoverQuote = ScreenerQuote & { extended?: ExtendedSessionDisplay | null };
export type MarketMoverRow = MoverQuote & { rank: number };

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
    case "preMarket":
    case "afterHours":
      return moverExtendedMove(row, columnId === "preMarket" ? "PRE" : "POST");
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

/** A row is rebuilt only when its quote or rank moved, so unchanged rows skip the render. */
const moverRows = new WeakMap<ScreenerQuote, MarketMoverRow>();

/** The extended print's move from the close, when the row has one for `session`. */
export function moverExtendedMove(row: MoverQuote, session: ExtendedSession): number | null {
  return row.extended?.session === session && isFiniteNumber(row.extended.changePercent) ? row.extended.changePercent : null;
}

/** The extended sessions some row has a print for, in the order their columns go. */
export function moverExtendedSessions(rows: readonly MoverQuote[]): ExtendedSession[] {
  return (["PRE", "POST"] as const).filter((session) => rows.some((row) => row.extended?.session === session));
}

export function createRows(quotes: readonly MoverQuote[]): MarketMoverRow[] {
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

/** An index in the summary strip, at its regular session's level and move. */
export function summaryQuoteFromQuote(symbol: string, quote: Quote): MarketSummaryQuote {
  const headline = getRegularSessionDisplay(quote)!;
  return {
    symbol,
    name: quote.name ?? symbol,
    price: headline.price,
    change: headline.change ?? Number.NaN,
    changePercent: headline.changePercent ?? Number.NaN,
  };
}

/** The extended print beside a quote's regular session, or null; a non-finite price is none. */
function moverExtended(quote: Quote): ExtendedSessionDisplay | null {
  const extended = getExtendedSessionDisplay(quote);
  return extended && isFiniteNumber(extended.price) ? extended : null;
}

/**
 * A trending row from its quote: Last and Chg% are the regular session, as
 * `ticker` reads it, and a pre-market or after-hours print rides beside them.
 */
export function screenerQuoteFromQuote(symbol: string, quote: Quote): MoverQuote {
  const headline = getRegularSessionDisplay(quote)!;
  return {
    symbol,
    name: quote.name ?? symbol,
    price: screenerNumber(headline.price),
    change: screenerNumber(headline.change),
    changePercent: screenerNumber(headline.changePercent),
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
    extended: moverExtended(quote),
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
const convertedOverlays = new WeakMap<ScreenerQuote, MoverQuote>();

/**
 * Live quotes on the list's rows, which keep the list's order. Price and
 * change are the regular session's, as `ticker` reads them, so after the
 * close they hold at it and a pre-market or after-hours print is the row's
 * `extended`. Range endpoints and the previous close belong to the original
 * screener price denomination.
 */
export function overlayMarketMoverQuotes(
  rows: readonly MoverQuote[],
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
): MoverQuote[] {
  return overlayScreenerQuoteEntries(rows, entries).map((row, index) => {
    const original = rows[index]!;
    if (row === original) return row;
    const cached = convertedOverlays.get(row);
    if (cached) return cached;
    const convert = (value: number | undefined) => convertScreenerPriceUnit(value, original.currency, row.currency);
    const quote = resolveEntryData(entries.get(buildQuoteKey({ symbol: row.symbol, exchange: row.exchange })));
    const headline = quote ? getRegularSessionDisplay(quote) : null;
    const converted = {
      ...row,
      ...(quote && headline ? {
        price: headline.price,
        change: isFiniteNumber(headline.change) ? headline.change : null,
        changePercent: isFiniteNumber(headline.changePercent) ? headline.changePercent : null,
        extended: moverExtended(quote),
      } : {}),
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
