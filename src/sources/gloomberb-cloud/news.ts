import { collectNewsDisplayTickers } from "../../news/ticker-symbols";
import type { NewsArticle, NewsQuery, NewsStoryItem } from "../../types/news-source";
import type {
  CloudNewsPayload,
  CloudNewsStoryItemPayload,
} from "../../api-client";
import type { CloudNewsParams } from "../../api-client/paths";
import { publicExchange } from "../../utils/exchanges";

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
    sourceName: item.sourceName || item.sourceKey,
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
  return {
    id: item.id,
    title: item.headline,
    url: item.primaryUrl,
    source: item.primarySource,
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
  const feed = query.feed ?? (query.scope === "ticker" ? "ticker" : "latest");
  return {
    feed,
    ticker: feed === "ticker" ? query.ticker : undefined,
    exchange: feed === "ticker" ? publicExchange(query.exchange) : undefined,
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
