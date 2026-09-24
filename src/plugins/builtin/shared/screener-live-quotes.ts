import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { publicTickerKey } from "../../../utils/exchanges";
import type { Quote } from "../../../types/financials";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QueryEntry } from "../../../market-data/result-types";
import { resolveCurrencyUnit } from "../../../utils/currency-units";

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

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
const overlayCache = new WeakMap<object, { quote: Quote; row: ScreenerQuoteRow }>();

export function overlayScreenerQuoteEntries<T extends ScreenerQuoteRow>(
  rows: readonly T[],
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
): T[] {
  return rows.map((row) => {
    const quote = resolveEntryData(entries.get(quoteKey(row)));
    if (!quote || !finite(quote.price)) return row;
    if (
      row.lastUpdated != null
      && Number.isFinite(row.lastUpdated)
      && quote.lastUpdated < row.lastUpdated
    ) {
      return row;
    }
    const cached = overlayCache.get(row);
    if (cached?.quote === quote) return cached.row as T;
    const overlaid = overlayQuote(row, quote);
    overlayCache.set(row, { quote, row: overlaid });
    return overlaid;
  });
}

function overlayQuote<T extends ScreenerQuoteRow>(row: T, quote: Quote): T {
  return {
    ...row,
    name: quote.name?.trim() || row.name,
    price: quote.price,
    change: finite(quote.change) ? quote.change : null,
    changePercent: finite(quote.changePercent)
      ? quote.changePercent
      : null,
    volume: finite(quote.volume) && quote.volume >= 0 ? quote.volume : null,
    currency: overlayCurrency(row, quote),
    previousClose: finite(quote.previousClose) ? quote.previousClose : undefined,
    lastUpdated: quote.lastUpdated,
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
