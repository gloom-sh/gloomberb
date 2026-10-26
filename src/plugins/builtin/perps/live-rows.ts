import { useCallback, useEffect, useMemo, useState } from "react";
import type { PerpBoardRow } from "../../../api-client/perps";
import { getServerClockOffsetMs } from "../../../market-data/quotes/clock";
import { buildQuoteKey, instrumentFromQuoteTarget } from "../../../market-data/selectors";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { perpetualListingOfMarket } from "../../../tickers/perpetual-listing";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";

/**
 * Perpetual markets move with the app's quote stream like any listing: a
 * market is quoted as the listing it is saved under (`BTC:HYPERLIQUID`), and
 * its quote carries the market's whole row, live while Gloom Cloud follows the
 * venue's own socket. A view that fetched rows (PERP's board, DES, a list's
 * perpetual columns) lays each quote's newer row over its own, so the one
 * subscription a watchlist row already holds feeds every view of the market.
 */

type Surface = NonNullable<QuoteSubscriptionTarget["surface"]>;

/** The quote target of a market, as its saved listing is quoted; null for a venue the app has no listing for. */
function perpQuoteTarget(marketId: string, surface: Surface = "detail", visible = true): QuoteSubscriptionTarget | null {
  const listing = perpetualListingOfMarket(marketId);
  return listing ? { symbol: listing.key, exchange: listing.exchange, route: "auto", surface, ...(visible ? { visible: true } : {}) } : null;
}

/** A fetched row with the newer reading a quote of its market brought; the row itself when the quote has none newer. */
export function withLiveReading(row: PerpBoardRow, quote: Quote | null | undefined): PerpBoardRow {
  const live = quote?.perpetual;
  if (!live || live.marketId.toLowerCase() !== row.marketId.toLowerCase()) return row;
  return Date.parse(live.observedAt) > Date.parse(row.observedAt) ? { ...row, ...live, marketId: row.marketId } : row;
}

/** As Gloom Cloud rules it: a market with no mark from its venue for a minute is no longer live. */
const LIVE_FOR_MS = 60_000;

/**
 * Whether a quote of a market is fed by its venue's socket now, not the minute's read: streamed live, not stale, and
 * marked within the last minute by the server's clock. The server says so too, but a socket that went quiet says
 * nothing, so the app keeps its own count.
 */
export function isLivePerpQuote(quote: Quote | null | undefined, now = Date.now() + (getServerClockOffsetMs() ?? 0)): boolean {
  return quote?.dataSource === "live" && quote.stale !== true && Number.isFinite(quote.lastUpdated)
    && now - quote.lastUpdated <= LIVE_FOR_MS;
}

/**
 * How long until a view looks again at whether its live rows still are: when the first one's minute runs out, a beat
 * after, never more than a minute away. A reading stamped ahead of the clock would otherwise ask for a timer past what
 * `setTimeout` holds, which fires at once, again and again.
 */
export function liveRecheckMs(expiresInMs: number): number {
  return Math.min(LIVE_FOR_MS, Math.max(0, expiresInMs) + 250);
}

/** The most rows one view follows on the quote stream at once: as many as the app streams (the socket's budget). */
const LIVE_ROW_LIMIT = 60;

/** The markets of the rows a view follows on the quote stream: the first LIVE_ROW_LIMIT. */
export const followedPerpMarkets = (rows: readonly Pick<PerpBoardRow, "marketId">[]) =>
  rows.slice(0, LIVE_ROW_LIMIT).map((row) => row.marketId);

export interface LivePerpRows {
  rows: readonly PerpBoardRow[];
  /** Every row followed is fed by its venue's socket now: the view may call itself live. */
  live: boolean;
  /** The markets fed by their venue's socket; the others are the minute's read. */
  liveMarkets: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Fetched rows with the quote stream's newer readings laid over them. Only the
 * first LIVE_ROW_LIMIT rows are subscribed: a list passes the rows in view.
 */
export function useLivePerpRows(
  rows: readonly PerpBoardRow[],
  { surface = "detail", visible = true, enabled = true }: { surface?: Surface; visible?: boolean; enabled?: boolean } = {},
): LivePerpRows {
  const marketKey = enabled ? followedPerpMarkets(rows).join("\u001f") : "";
  const targets = useMemo(() => marketKey ? marketKey.split("\u001f").flatMap((marketId) => {
    const target = perpQuoteTarget(marketId, surface, visible);
    return target ? [target] : [];
  }) : [], [marketKey, surface, visible]);
  const { entries } = useLiveQuoteEntries(targets);
  // Ticks when a live row's minute runs out, so a feed that went quiet stops calling itself live.
  const [expired, setExpired] = useState(0);
  const result = useMemo(() => {
    if (!targets.length) return { rows, live: false, liveMarkets: NONE, expiresAt: null };
    const now = Date.now() + (getServerClockOffsetMs() ?? 0);
    const followed = new Set(targets.map((target) => buildQuoteKey(instrumentFromQuoteTarget(target))));
    const followedMarkets = new Set(marketKey.split("\u001f").filter((marketId) => perpQuoteTarget(marketId, surface, visible)));
    const quoteOf = (marketId: string) => {
      const target = perpQuoteTarget(marketId, surface, visible);
      if (!target) return null;
      const key = buildQuoteKey(instrumentFromQuoteTarget(target));
      const entry = followed.has(key) ? entries.get(key) : undefined;
      return entry?.data ?? entry?.lastGoodData ?? null;
    };
    const liveMarkets = new Set<string>();
    let expiresAt: number | null = null;
    const next = rows.map((row) => {
      const quote = quoteOf(row.marketId);
      if (quote && isLivePerpQuote(quote, now)) {
        liveMarkets.add(row.marketId);
        expiresAt = Math.min(expiresAt ?? Number.POSITIVE_INFINITY, quote.lastUpdated + LIVE_FOR_MS - now);
      }
      return withLiveReading(row, quote);
    });
    const live = [...followedMarkets].every((marketId) => liveMarkets.has(marketId));
    return { rows: next, live, liveMarkets, expiresAt };
    // `expired` is the clock that ends a quiet row's minute.
  }, [entries, expired, marketKey, rows, surface, targets, visible]);
  useEffect(() => {
    if (result.expiresAt == null) return;
    const timer = setTimeout(() => setExpired((count) => count + 1), liveRecheckMs(result.expiresAt));
    return () => clearTimeout(timer);
  }, [result]);
  return result;
}

interface Range { start: number; end: number }
/** Rows a table starts with before it measures its viewport: a pane's height of them. */
const FIRST_VIEW: Range = { start: 0, end: 40 };

/**
 * A table's rows with the quote stream laid over the ones in view: pass
 * `onVisibleRangeChange` to the table, and its rows in view (and the row
 * `pinned`, the one other tabs follow) are subscribed as it scrolls. `shown`
 * is what the footer dates, the items in view, and `live` says whether every
 * one of them streams.
 */
export function useLivePerpTableRows<T>(
  items: readonly T[],
  rowOf: (item: T) => PerpBoardRow | null,
  withRow: (item: T, row: PerpBoardRow) => T,
  { surface = "screener", pinned = null }: { surface?: Surface; pinned?: PerpBoardRow | null } = {},
): { items: T[]; shown: T[]; live: boolean; onVisibleRangeChange: (range: Range) => void } {
  const [range, setRange] = useState<Range>(FIRST_VIEW);
  const onVisibleRangeChange = useCallback((next: Range) => {
    setRange((current) => current.start === next.start && current.end === next.end ? current : next);
  }, []);
  const inView = useMemo(() => {
    const rows = new Map<string, PerpBoardRow>();
    if (pinned) rows.set(pinned.marketId, pinned);
    for (const item of items.slice(range.start, range.end)) {
      const row = rowOf(item);
      if (row) rows.set(row.marketId, row);
    }
    return [...rows.values()];
  }, [items, pinned, range, rowOf]);
  const live = useLivePerpRows(inView, { surface });
  const next = useMemo(() => {
    const byMarket = new Map(live.rows.map((row) => [row.marketId, row]));
    return items.map((item) => {
      const row = rowOf(item);
      const fresh = row ? byMarket.get(row.marketId) : undefined;
      return row && fresh && fresh !== row ? withRow(item, fresh) : item;
    });
  }, [items, live.rows, rowOf, withRow]);
  const view = useMemo(() => {
    const shown = next.slice(range.start, range.end);
    const rows = shown.flatMap((item) => rowOf(item) ?? []);
    return { shown, live: rows.length > 0 && rows.every((row) => live.liveMarkets.has(row.marketId)) };
  }, [next, range, rowOf, live.liveMarkets]);
  return { items: next, shown: view.shown, live: view.live, onVisibleRangeChange };
}
