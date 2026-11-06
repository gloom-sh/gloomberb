import { instrumentFromTicker } from "../../../market-data/request-types";
import type { NewsQuery } from "../../../news/types";
import type { TickerRecord } from "../../../types/ticker";

/** The Ticker Research view of a company's news, and the function (CN) that opens it in a pane of its own. */
export const TICKER_NEWS_TAB_ID = "news";
export const TICKER_NEWS_TEMPLATE_ID = "ticker-news-pane";

const NEWS_ITEM_LIMIT = 50;

/**
 * The company news a ticker's News view lists. The overview's latest
 * headlines read the same feed, so the view they open is already loaded and
 * lists the stories they showed.
 */
export function tickerNewsQuery(ticker: TickerRecord | null | undefined): NewsQuery | null {
  const instrument = instrumentFromTicker(ticker, ticker?.metadata.ticker ?? null);
  return instrument ? {
    feed: "ticker",
    ticker: instrument.symbol,
    exchange: instrument.exchange,
    tickerTier: "primary",
    limit: NEWS_ITEM_LIMIT,
    ...(ticker?.metadata.name ? { listingName: ticker.metadata.name } : {}),
  } : null;
}

/**
 * The News view's pane state for one symbol: the row its cursor is on and the
 * story it has open. A story opened from the overview is put there, so the
 * view shows it, and Back lands on its row.
 */
export function tickerNewsStateKeys(symbol: string): { selectedArticleId: string; openArticleId: string } {
  return { selectedArticleId: `selectedArticleId:${symbol}`, openArticleId: `openArticleId:${symbol}` };
}
