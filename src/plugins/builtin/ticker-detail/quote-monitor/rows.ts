import type { Quote } from "../../../../types/financials";
import type { HeadlessPaneColumn, HeadlessPaneRow } from "../../../../types/headless";
import { EXTENDED_SESSION_LABELS, getQuoteSessionFields, quoteHeadlineTime, quoteSessionStateLabel, type ExtendedSession } from "../../../../market-data/market/status";
import { changeBasisLabel, quoteChangeBasis } from "../../../../market-data/market/change-basis";
import {
  formatMarketChangeWithCurrency, formatMarketPrice, formatMarketPriceWithCurrency, resolveAssetDisplayKind, withCurrencyMinorDigits,
  type MarketFormatOptions,
} from "../../../../market-data/market/format";
import { quoteExportFeed, quoteExportUnit, quoteSourceName, type BrokerNameOf } from "../../../../market-data/quotes/export-identity";
import { isYieldIndexSymbol } from "../../../../tickers/index-roots";
import { toBasisPoints } from "../../../../utils/basis-points";
import { formatPercentRaw } from "../../../../utils/format";
import { parsePublicTickerKey } from "../../../../utils/exchanges";
import { quoteFreshnessFields } from "../../shared/report-freshness";

/**
 * The Quote Monitor's rows as `fn QQ` reports them and the pane's Export CSV
 * writes them: one model, so the board's file and the CLI's agree cell for cell.
 */

/** A price or move in the row's own currency, as the cards draw it. */
function quoteAmount(value: unknown, row: Record<string, unknown>, signed = false): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const currency = typeof row.currency === "string" && row.currency.trim() ? row.currency : undefined;
  const base: MarketFormatOptions = { assetCategory: typeof row.instrumentType === "string" ? row.instrumentType : undefined,
    priceBasis: row.priceBasis === "per-unit" || row.priceBasis === "percent-of-par" ? row.priceBasis : undefined };
  // Par quotes keep two decimals; money pads to its currency's minor unit (none for JPY).
  const options = base.priceBasis === "percent-of-par" ? { ...base, minimumFractionDigits: 2 } : withCurrencyMinorDigits(base, currency);
  // A currency pair's move is written at the pair's precision, as its price is (-$0.00108 on EUR/USD 1.16023).
  if (signed && currency && typeof row.price === "number" && resolveAssetDisplayKind(options) === "cash") {
    return formatMarketChangeWithCurrency(value, currency, options, row.price);
  }
  const amount = currency
    ? formatMarketPriceWithCurrency(value, currency, options)
    : formatMarketPrice(value, options);
  return amount === "—" ? amount : `${signed && value >= 0 ? "+" : ""}${amount}`;
}

function percentCell(value: unknown): string {
  return formatPercentRaw(typeof value === "number" && Number.isFinite(value) ? value : undefined);
}

// Last and Change are in each row's own unit, which an export names in `currency_or_unit` and leaves out of the figures.
// An export writes the move to the digits the board shows (-315.12, -1.27), and Last whole, as `quote --csv` does
// (a yield's 4.859, which the board draws 4.86); JSON keeps every figure whole.
const QUOTE_MONITOR_COLUMNS: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" },
  { key: "name", header: "Name" },
  { key: "price", header: "Last", align: "right", unitKey: "unit", format: (value, row) => quoteAmount(value, row) },
  { key: "change", header: "Change", align: "right", unitKey: "unit", exportAsShown: true, format: (value, row) => quoteAmount(value, row, true) },
  { key: "changePercent", header: "Change %", align: "right", exportAsShown: true, format: percentCell },
];

/**
 * What each row's figures are as of, as `quote --csv` says it: the session
 * (CLOSED, REGULAR, PRE-MKT), whether the feed is live, delayed or stale, and
 * what the move is from. A narrow terminal drops them before it cuts a name.
 */
const QUOTE_MONITOR_SESSION_COLUMNS: HeadlessPaneColumn[] = [
  { key: "changeBasis", header: "Chg Basis", optional: true, dropPriority: 1 },
  { key: "session", header: "Session", optional: true, dropPriority: 3 },
  { key: "feed", header: "Feed", optional: true, dropPriority: 2 },
];

/** A Cboe yield's move in basis points, the figure its card reads (+2.2bp), as `quote --csv` exports it. */
const CHANGE_BP_COLUMN: HeadlessPaneColumn = {
  key: "changeBasisPoints", header: "Chg bp", align: "right", optional: true, dropPriority: 0,
  format: (value) => typeof value === "number" && Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}` : "",
};

/** The pre-market, after-hours or overnight print and its move from the regular close, for the rows that have one. */
function extendedSessionColumn(session: ExtendedSession): HeadlessPaneColumn {
  return {
    key: "extendedPrice", header: EXTENDED_SESSION_LABELS[session], align: "right",
    format: (value, row) => row.extendedSession === session
      ? `${quoteAmount(value, row)} ${percentCell(row.extendedChangePercent)}`
      : "—",
  };
}

/** Every column a board's rows draw: an extended session's only when a row has its print, Chg bp only beside a yield. */
export function quoteMonitorColumns(rows: readonly HeadlessPaneRow[]): HeadlessPaneColumn[] {
  const extended = (["PRE", "POST", "OVERNIGHT"] as const)
    .filter((session) => rows.some((row) => row.extendedSession === session))
    .map(extendedSessionColumn);
  const yields = rows.some((row) => row.changeBasisPoints != null);
  return [...QUOTE_MONITOR_COLUMNS, ...extended, ...QUOTE_MONITOR_SESSION_COLUMNS, ...yields ? [CHANGE_BP_COLUMN] : []];
}

/** The columns a board starts with, before its rows say which sessions and yields it holds. */
export const QUOTE_MONITOR_BASE_COLUMNS: HeadlessPaneColumn[] = [...QUOTE_MONITOR_COLUMNS, ...QUOTE_MONITOR_SESSION_COLUMNS];

/** The row fields an export reads each row's identity from: its listing, unit, source and as-of. */
export const QUOTE_MONITOR_ROW_KEYS = { rowSymbolKey: "symbol", rowUnitKey: "unit", rowAsOfKey: "updatedAt", rowSourceKey: "source" } as const;

/**
 * One card as a row: the regular session's Last, change and percent change,
 * any extended print, what the move is from, the session and feed, and each
 * row's own as-of (Hong Kong's close beside New York's), its unit and source.
 * `symbol` is the listing with its venue (0005:HKEX).
 */
export function quoteMonitorRow(symbol: string, quote: Quote, now = Date.now(), brokerName?: BrokerNameOf): HeadlessPaneRow {
  // As the pane's cards show them: the regular session, then any extended print from its close.
  const { price, change, changePercent, ...extended } = getQuoteSessionFields(quote);
  const basis = quoteChangeBasis(quote);
  const yieldIndex = isYieldIndexSymbol(parsePublicTickerKey(symbol).symbol);
  return {
    symbol, name: quote.name ?? "", price, currency: quote.currency, unit: quoteExportUnit(symbol, quote),
    ...(quote.instrumentType ? { instrumentType: quote.instrumentType } : {}),
    ...(quote.priceBasis ? { priceBasis: quote.priceBasis } : {}),
    change, changePercent, ...extended,
    ...(yieldIndex && change != null && Number.isFinite(change) ? { changeBasisPoints: toBasisPoints(change, 1) } : {}),
    session: quoteSessionStateLabel(quote, now) ?? "",
    feed: quoteExportFeed(quote, now),
    changeBasis: basis ? changeBasisLabel(basis, now) : "",
    source: quoteSourceName(quote, brokerName),
    marketCap: quote.marketCap ?? null, updatedAt: quoteHeadlineTime(quote),
    ...quoteFreshnessFields(quote, now),
  };
}
