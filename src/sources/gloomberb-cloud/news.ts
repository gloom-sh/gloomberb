import { normalizeNewsFeed } from "../../news/news-model";
import { readableNewsSource } from "../../news/source-label";
import { collectNewsDisplayTickers } from "../../news/ticker-symbols";
import type { NewsAccess, NewsArticle, NewsQuery, NewsStoryItem } from "../../types/news-source";
import { CLOUD_NEWS_DELAY_HOURS } from "../../api-client/plan-rules";
import type {
  apiClient,
  CloudNewsListResponse,
  CloudNewsPayload,
  CloudNewsStoryItemPayload,
} from "../../api-client";
import type { CloudNewsParams } from "../../api-client/paths";
import { parsePublicTickerKey, publicExchange } from "../../utils/exchanges";
import { coinSearchName } from "../../utils/crypto-pair";
import { logFailure } from "../../utils/log-failure";
import { getListingSymbol, tickerHasListingSuffix } from "../listing-symbols";

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mapCloudNewsTickers(
  item: CloudNewsPayload,
  fallbackTicker?: string,
): string[] {
  const tickers = collectNewsDisplayTickers(
    item.tickerLinks.flatMap((link) => [link.symbol, link.canonicalTicker]),
  );
  const fallbackTickers = collectNewsDisplayTickers([fallbackTicker]);
  if (tickers.length === 0) tickers.push(...fallbackTickers);
  return tickers;
}

function mapCloudNewsStoryItem(
  item: CloudNewsStoryItemPayload,
): NewsStoryItem {
  const publishedAt = new Date(item.publishedAt);
  return {
    id: item.id,
    sourceKey: item.sourceKey,
    sourceName: item.sourceName || readableNewsSource(item.sourceKey),
    title: item.title,
    summary: item.summary,
    url: item.url,
    publishedAt: Number.isNaN(publishedAt.getTime())
      ? new Date(0)
      : publishedAt,
    hasArticleText: item.hasArticleText,
  };
}

export function mapCloudNewsArticle(
  item: CloudNewsPayload,
  fallbackTicker?: string,
): NewsArticle {
  const publishedAt = new Date(
    item.lastPublishedAt || item.firstPublishedAt || item.lastSeenAt,
  );
  const topic = item.topic ?? item.category ?? "general";
  const topics = uniqueStrings([topic, ...normalizeStringArray(item.topics)]);
  const sectors = normalizeStringArray(item.sectors);
  const scores = {
    importance: item.scores?.importance ?? 0,
    urgency: item.scores?.urgency ?? 0,
    marketImpact: item.scores?.marketImpact ?? 0,
    novelty: item.scores?.novelty ?? 0,
    confidence: item.scores?.confidence ?? 0,
  };
  const tickers = mapCloudNewsTickers(item, fallbackTicker);
  // primarySource is the cloud's routing key ("prnewswire-americas"); readers
  // see the publisher the service names, or the story item it points at.
  const primaryItem = item.items?.find((entry) => entry.sourceKey === item.primarySource);
  return {
    id: item.id,
    title: item.headline,
    url: item.primaryUrl,
    source: item.primaryPublisher
      || primaryItem?.sourceName
      || readableNewsSource(item.primarySource),
    publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date(0) : publishedAt,
    summary: item.summary,
    topic,
    topics,
    sectors,
    categories: uniqueStrings([...topics, ...sectors]),
    tickers,
    sentiment: item.sentiment,
    scores,
    importance: scores.importance,
    isBreaking: !!item.flags?.breaking,
    isDeveloping: !!item.flags?.developing,
    sourceCount: item.sourceCount,
    items: item.items?.map(mapCloudNewsStoryItem) ?? [],
  };
}

export function cloudNewsParams(query: NewsQuery): CloudNewsParams {
  const feed = normalizeNewsFeed(query);
  const ticker = query.ticker ? parsePublicTickerKey(query.ticker) : undefined;
  const exchange = ticker?.exchange ?? query.exchange;
  let symbol = ticker?.symbol;
  if (symbol && exchange && tickerHasListingSuffix(symbol)) {
    const baseSymbol = symbol.slice(0, symbol.lastIndexOf("."));
    if (getListingSymbol(baseSymbol, exchange) === symbol) symbol = baseSymbol;
  }
  return {
    feed,
    ticker: feed === "ticker" ? symbol : undefined,
    exchange: feed === "ticker" ? publicExchange(exchange) : undefined,
    tickerTier:
      feed === "ticker" ? query.tickerTier ?? "primary" : query.tickerTier,
    tickerRelations: query.tickerRelations,
    limit: query.limit,
    topics: query.topics,
    categories: query.topics ? undefined : query.categories,
    sectors: query.sectors,
    sources: query.sources,
    excludeSources: query.excludeSources,
    sentiment: query.sentiment,
    minImportance: query.minImportance,
    minUrgency: query.minUrgency,
    breaking: query.breaking,
    since: query.since,
    until: query.until,
    cursor: query.cursor,
  };
}

/**
 * A page of Gloom Cloud stories, with the text searched for when a coin pair's
 * feed had none filed under it, and which news the service answered with.
 */
export type CloudNewsRead = Omit<CloudNewsListResponse, "access"> & { searchedFor?: string; access?: NewsAccess | null };

/**
 * How recently the service must have seen a story for the answer to be the
 * live wire. It holds a story back from an account without real-time news
 * until it last saw it {@link CLOUD_NEWS_DELAY_HOURS} hours ago; the hour
 * less leaves room for this clock and the service's to disagree.
 */
const LIVE_STORY_WINDOW_MS = (CLOUD_NEWS_DELAY_HOURS - 1) * 60 * 60 * 1000;

/**
 * Which news a Gloom Cloud answer is, from the answer: what the service says
 * when it says it; held back when the request carried no session, since the
 * service holds news back for anyone it cannot name; live when it holds a
 * story seen too recently to have been held back. Otherwise null: a quiet
 * feed read live looks the same as a held-back one.
 */
export function cloudNewsAccess(
  response: Pick<CloudNewsListResponse, "items" | "access">,
  sentSession: boolean,
  now = Date.now(),
): NewsAccess | null {
  if (response.access === "realtime" || response.access === "delayed") return response.access;
  if (!sentSession) return "delayed";
  const live = response.items.some((item) => {
    const seenAt = Date.parse(item.lastSeenAt);
    return Number.isFinite(seenAt) && now - seenAt < LIVE_STORY_WINDOW_MS;
  });
  return live ? "realtime" : null;
}

/** A client that cannot say whether a session goes with its requests (a test double) is taken to send one. */
type CloudNewsClient = Pick<typeof apiClient, "getCloudNews" | "searchCloudNews">
  & Partial<Pick<typeof apiClient, "hasSessionCredential">>;

/**
 * A news query's first page from Gloom Cloud. Stories are filed under company
 * tickers, and a coin pair (BTC-USD) rarely has any filed under it, so its
 * empty feed falls back to the stories that mention the coin ("bitcoin"),
 * marked with what was searched. A later page, a failed search or a coin with
 * no name to search keeps the empty answer.
 */
export async function readCloudNews(client: CloudNewsClient, query: NewsQuery): Promise<CloudNewsRead> {
  // Asked in the tick the request goes out in, which is when its headers take the session.
  const sentSession = client.hasSessionCredential?.() ?? true;
  const response = await client.getCloudNews(cloudNewsParams(query));
  const read: CloudNewsRead = { ...response, access: cloudNewsAccess(response, sentSession) };
  if (response.items.length > 0 || query.cursor || normalizeNewsFeed(query) !== "ticker") return read;
  const text = coinSearchName(query.ticker, query.exchange, query.listingName);
  if (!text) return read;
  const found = await client.searchCloudNews(text, query.limit)
    .catch(logFailure("sources.gloomberb-cloud.news", "Search a coin's stories failed", null));
  return found && found.items.length > 0
    ? { items: found.items, nextCursor: null, searchedFor: text, access: cloudNewsAccess(found, sentSession) }
    : read;
}

/** A read's stories as articles, each marked with the text a coin's fallback searched for. */
export function cloudNewsReadArticles(read: CloudNewsRead, ticker?: string): NewsArticle[] {
  return read.items.map((item) => {
    const article = mapCloudNewsArticle(item, read.searchedFor ? undefined : ticker);
    return read.searchedFor ? { ...article, searchedFor: read.searchedFor } : article;
  });
}

/** What a pane or report says above the stories a coin's fallback found: "No stories are filed under BTC-USD; these mention bitcoin." */
export function coinNewsFallbackNotice(ticker: string, searchedFor: string): string {
  return `No stories are filed under ${ticker}; these mention ${searchedFor}.`;
}
