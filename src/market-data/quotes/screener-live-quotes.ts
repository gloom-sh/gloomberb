import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import { publicTickerKey } from "../../utils/exchanges";
import type { Quote } from "../../types/financials";
import { buildQuoteKey, resolveEntryData } from "../selectors";
import type { QueryEntry } from "../result-types";
import { resolveCurrencyUnit } from "../../utils/currency-units";
import { isFiniteNumber } from "../../utils/guards";
import { getCompletedRegularSessionDisplay, getSessionMoveDisplay, type ExtendedSession } from "../market/status";

const STREAM_FRESHNESS_MS = 2 * 60_000;
const STREAM_CONNECTING_GRACE_MS = 15_000;

export interface ScreenerQuoteRow {
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  currency: string;
  exchange: string;
  lastUpdated?: number;
  previousClose?: number;
  /** Set when the price and move are an open pre-market or after-hours session's (see `extendedSessions`). */
  extendedSession?: ExtendedSession;
  /** Set when the price and move are the last completed regular session's close and its move; the move, in percent. */
  regularChangePercent?: number | null;
}

export interface ScreenerQuoteOverlayOptions {
  /**
   * While a pre-market or after-hours session is open, show its price and its
   * move from the regular close, marked with `extendedSession`; otherwise the
   * regular session's, which stops at the close. Without it a row shows the
   * live price against the previous close. A row that is a completed regular
   * session's close and move (`regularChangePercent`) keeps them outside the
   * regular session when its quote has neither an open extended print nor
   * that session's close of its own, so its price and move never come from
   * two different days.
   */
  extendedSessions?: boolean;
}

export interface ScreenerQuoteFreshness {
  now: number;
  subscriptionStartedAt: number;
}

export type ScreenerQuoteFeedStatus = "live" | "mixed" | "polling";

export function buildScreenerQuoteTargets(
  rows: readonly Pick<ScreenerQuoteRow, "symbol" | "exchange">[],
  selectedSymbol: string | null,
): QuoteSubscriptionTarget[] {
  return rows.map((row) => ({
    symbol: row.symbol,
    exchange: row.exchange,
    surface: "screener",
    visible: true,
    selected: row.symbol === selectedSymbol || publicTickerKey(row.symbol, row.exchange) === selectedSymbol,
    weight: row.symbol === selectedSymbol || publicTickerKey(row.symbol, row.exchange) === selectedSymbol ? 100 : 70,
  }));
}

function quoteKey(row: Pick<ScreenerQuoteRow, "symbol" | "exchange">): string {
  return buildQuoteKey({ symbol: row.symbol, exchange: row.exchange });
}

/** Venues quote these in either the major or the minor unit (GBP or GBp). */
const TWO_UNIT_CURRENCIES = new Set(["GBP", "ILS", "ZAR"]);

/** A quote without a currency keeps the listing's, so a streamed price never
 * loses its symbol, unless the listing's currency has two units and the
 * quote's could be either. */
function overlayCurrency(row: ScreenerQuoteRow, quote: Quote): string {
  const quoted = quote.currency?.trim();
  if (quoted) return quoted;
  return TWO_UNIT_CURRENCIES.has(resolveCurrencyUnit(row.currency).currency) ? "" : row.currency;
}

/**
 * The last overlay of each source row. Every stream flush hands over a new
 * entries map, but most rows' quotes did not move; returning the same row
 * object for those lets memoized table rows skip the render.
 */
const overlayCache = new WeakMap<object, { quote: Quote; extended: boolean; row: ScreenerQuoteRow }>();

export function overlayScreenerQuoteEntries<T extends ScreenerQuoteRow>(
  rows: readonly T[],
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
  options: ScreenerQuoteOverlayOptions = {},
): T[] {
  const extended = options.extendedSessions === true;
  return rows.map((row) => {
    const quote = resolveEntryData(entries.get(quoteKey(row)));
    if (!quote || !isFiniteNumber(quote.price)) return row;
    if (
      row.lastUpdated != null
      && Number.isFinite(row.lastUpdated)
      && quote.lastUpdated < row.lastUpdated
    ) {
      return row;
    }
    const cached = overlayCache.get(row);
    if (cached?.quote === quote && cached.extended === extended) return cached.row as T;
    const overlaid = extended ? overlaySessionQuote(row, quote) : overlayQuote(row, quote);
    overlayCache.set(row, { quote, extended, row: overlaid });
    return overlaid;
  });
}

function overlayQuote<T extends ScreenerQuoteRow>(row: T, quote: Quote): T {
  return {
    ...row,
    name: quote.name?.trim() || row.name,
    price: quote.price,
    change: isFiniteNumber(quote.change) ? quote.change : null,
    changePercent: isFiniteNumber(quote.changePercent)
      ? quote.changePercent
      : null,
    volume: isFiniteNumber(quote.volume) && quote.volume >= 0 ? quote.volume : null,
    currency: overlayCurrency(row, quote),
    previousClose: isFiniteNumber(quote.previousClose) ? quote.previousClose : undefined,
    lastUpdated: quote.lastUpdated,
    // The streamed price and move are no longer the snapshot's completed session.
    ...(row.regularChangePercent !== undefined ? { regularChangePercent: null } : {}),
  };
}

function overlaySessionQuote<T extends ScreenerQuoteRow>(row: T, quote: Quote): T {
  const overlaid = overlayQuote(row, quote);
  const display = getSessionMoveDisplay(quote);
  if (!display || !isFiniteNumber(display.price)) return overlaid;
  if (
    !display.session
    && row.regularChangePercent != null
    && quote.marketState != null
    && quote.marketState !== "REGULAR"
    && !getCompletedRegularSessionDisplay(quote)
  ) {
    return { ...overlaid, price: row.price, change: row.change, changePercent: row.changePercent, regularChangePercent: row.regularChangePercent };
  }
  return {
    ...overlaid,
    price: display.price,
    change: isFiniteNumber(display.change) ? display.change : null,
    changePercent: isFiniteNumber(display.changePercent) ? display.changePercent : null,
    extendedSession: display.session,
  };
}

function freshQuote(
  entry: QueryEntry<Quote> | undefined,
  freshness: ScreenerQuoteFreshness,
): Quote | null {
  const quote = resolveEntryData(entry);
  if (!quote || quote.stale === true) return null;
  const receivedAt = quote.receivedAt ?? 0;
  if (
    !Number.isFinite(receivedAt)
    || receivedAt < freshness.subscriptionStartedAt
    || freshness.now - receivedAt > STREAM_FRESHNESS_MS
  ) {
    return null;
  }
  return quote;
}

export function resolveScreenerQuoteFeedStatus(
  targets: readonly QuoteSubscriptionTarget[],
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
  freshness: ScreenerQuoteFreshness,
): ScreenerQuoteFeedStatus | null {
  if (targets.length === 0) return null;
  let liveCount = 0;
  let fallbackCount = 0;

  for (const target of targets) {
    const quote = freshQuote(
      entries.get(buildQuoteKey({
        symbol: target.symbol,
        exchange: target.exchange,
      })),
      freshness,
    );
    if (
      quote?.dataSource === "live"
      && quote.delivery === "stream"
      && quote.stale === false
    ) {
      liveCount += 1;
    } else if (quote) {
      fallbackCount += 1;
    }
  }

  if (liveCount === targets.length) return "live";
  if (liveCount > 0) return "mixed";
  // The socket connects in the background; there is nothing to report yet.
  if (
    fallbackCount === 0
    && freshness.now - freshness.subscriptionStartedAt < STREAM_CONNECTING_GRACE_MS
  ) {
    return null;
  }
  return "polling";
}
