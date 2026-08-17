import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QueryEntry } from "../../../market-data/result-types";

const STREAM_FRESHNESS_MS = 2 * 60_000;
const STREAM_CONNECTING_GRACE_MS = 15_000;

export interface ScreenerQuoteRow {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number | null;
  currency: string;
  exchange: string;
  lastUpdated?: number;
}

export interface ScreenerQuoteFreshness {
  now: number;
  subscriptionStartedAt: number;
}

export type ScreenerQuoteFeedStatus = "live" | "mixed" | "connecting" | "polling";

export function buildScreenerQuoteTargets(
  rows: readonly Pick<ScreenerQuoteRow, "symbol" | "exchange">[],
  selectedSymbol: string | null,
): QuoteSubscriptionTarget[] {
  return rows.map((row) => ({
    symbol: row.symbol,
    exchange: row.exchange,
    surface: "screener",
    visible: true,
    selected: row.symbol === selectedSymbol,
    weight: row.symbol === selectedSymbol ? 100 : 70,
  }));
}

function quoteKey(row: Pick<ScreenerQuoteRow, "symbol" | "exchange">): string {
  return buildQuoteKey({ symbol: row.symbol, exchange: row.exchange });
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

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

    return {
      ...row,
      name: quote.name?.trim() || row.name,
      price: quote.price,
      change: finite(quote.change) ? quote.change : row.change,
      changePercent: finite(quote.changePercent)
        ? quote.changePercent
        : row.changePercent,
      volume: finite(quote.volume) ? quote.volume : row.volume,
      currency: quote.currency || row.currency,
      lastUpdated: quote.lastUpdated,
    };
  });
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
  if (
    fallbackCount === 0
    && freshness.now - freshness.subscriptionStartedAt < STREAM_CONNECTING_GRACE_MS
  ) {
    return "connecting";
  }
  return "polling";
}
