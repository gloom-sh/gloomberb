import { useCallback, useMemo, useState } from "react";
import type { PerpBoardRow } from "../../../api-client/perps";
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

/** Whether a quote of a market is fed by its venue's socket now, not the minute's read. */
const isLive = (quote: Quote | null | undefined) => quote?.dataSource === "live" && quote.stale !== true;

export interface LivePerpRows {
  rows: readonly PerpBoardRow[];
  /** Some row shown is fed by its venue's socket. */
  live: boolean;
}

/**
 * Fetched rows with the quote stream's newer readings laid over them. Only the
 * first `limit` rows are subscribed: a list passes the rows in view.
 */
export function useLivePerpRows(
  rows: readonly PerpBoardRow[],
  { surface = "detail", visible = true, limit = 40, enabled = true }: { surface?: Surface; visible?: boolean; limit?: number; enabled?: boolean } = {},
): LivePerpRows {
  const marketKey = enabled ? rows.slice(0, limit).map((row) => row.marketId).join("\u001f") : "";
  const targets = useMemo(() => marketKey ? marketKey.split("\u001f").flatMap((marketId) => {
    const target = perpQuoteTarget(marketId, surface, visible);
    return target ? [target] : [];
  }) : [], [marketKey, surface, visible]);
  const { entries } = useLiveQuoteEntries(targets);
  return useMemo(() => {
    if (!targets.length) return { rows, live: false };
    const quoteOf = (marketId: string) => {
      const target = perpQuoteTarget(marketId, surface, visible);
      if (!target) return null;
      const entry = entries.get(buildQuoteKey(instrumentFromQuoteTarget(target)));
      return entry?.data ?? entry?.lastGoodData ?? null;
    };
    let live = false;
    const next = rows.map((row) => {
      const quote = quoteOf(row.marketId);
      if (isLive(quote)) live = true;
      return withLiveReading(row, quote);
    });
    return { rows: next, live };
  }, [entries, rows, surface, targets.length, visible]);
}

interface Range { start: number; end: number }
/** Rows a table starts with before it measures its viewport: a pane's height of them. */
const FIRST_VIEW: Range = { start: 0, end: 40 };

/**
 * A table's rows with the quote stream laid over the ones in view: pass
 * `onVisibleRangeChange` to the table, and its rows in view (and the row
 * `pinned`, the one other tabs follow) are subscribed as it scrolls.
 */
export function useLivePerpTableRows<T>(
  items: readonly T[],
  rowOf: (item: T) => PerpBoardRow | null,
  withRow: (item: T, row: PerpBoardRow) => T,
  { surface = "screener", pinned = null }: { surface?: Surface; pinned?: PerpBoardRow | null } = {},
): { items: T[]; live: boolean; onVisibleRangeChange: (range: Range) => void } {
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
  const live = useLivePerpRows(inView, { surface, limit: 60 });
  const next = useMemo(() => {
    const byMarket = new Map(live.rows.map((row) => [row.marketId, row]));
    return items.map((item) => {
      const row = rowOf(item);
      const fresh = row ? byMarket.get(row.marketId) : undefined;
      return row && fresh && fresh !== row ? withRow(item, fresh) : item;
    });
  }, [items, live.rows, rowOf, withRow]);
  return { items: next, live: live.live, onVisibleRangeChange };
}
