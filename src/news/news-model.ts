import { canonicalExchange, normalizeSymbol } from "../utils/exchanges";
import type { NewsCapability } from "../capabilities";
import type { NewsArticle, NewsFeed, NewsQuery, NewsQueryState } from "./types";

const MAX_ARTICLES = 500;
export const DEFAULT_GLOBAL_QUERY: NewsQuery = { feed: "latest", limit: MAX_ARTICLES };

const FEEDS = new Set<NewsFeed>(["latest", "top", "breaking", "ticker", "sector", "topic"]);
const DETAIL_CAPABLE_ARTICLE = Symbol("detail-capable-news-article");

type DetailCapableArticle = NewsArticle & { [DETAIL_CAPABLE_ARTICLE]?: true };

function normalizeTicker(ticker: string | undefined): string {
  return ticker ? normalizeSymbol(ticker) : "";
}

export function normalizeNewsCategory(category: string): string {
  return category.trim().toLowerCase();
}

export function normalizeNewsFeed(query: NewsQuery): NewsFeed {
  if (query.feed && FEEDS.has(query.feed)) return query.feed;
  return query.scope === "ticker" ? "ticker" : "latest";
}

function normalizeStringList(values: string[] | undefined): string[] | undefined {
  const normalized = [...new Set((values ?? []).map(normalizeNewsCategory).filter(Boolean))].sort();
  return normalized.length > 0 ? normalized : undefined;
}

export function buildNewsQueryKey(query: NewsQuery): string {
  const feed = normalizeNewsFeed(query);
  const ticker = normalizeTicker(query.ticker);
  const exchange = canonicalExchange(query.exchange);
  const topics = normalizeStringList(query.topics ?? query.categories) ?? [];
  const sectors = normalizeStringList(query.sectors) ?? [];
  const sources = normalizeStringList(query.sources) ?? [];
  const excludeSources = normalizeStringList(query.excludeSources) ?? [];
  const tickerRelations = normalizeStringList(query.tickerRelations) ?? [];
  return [
    feed,
    ticker,
    exchange,
    query.tickerTier ?? "",
    query.limit ?? MAX_ARTICLES,
    topics.join(","),
    sectors.join(","),
    sources.join(","),
    excludeSources.join(","),
    tickerRelations.join(","),
    query.sentiment ?? "",
    query.minImportance ?? "",
    query.minUrgency ?? "",
    query.breaking == null ? "" : String(query.breaking),
    query.since?.toISOString() ?? "",
    query.until?.toISOString() ?? "",
    query.cursor ?? "",
  ].join("|");
}

export function normalizeNewsQuery(query: NewsQuery): NewsQuery {
  const feed = normalizeNewsFeed(query);
  const topics = normalizeStringList(query.topics ?? query.categories);
  const sectors = normalizeStringList(query.sectors);
  return {
    ...query,
    feed,
    scope: feed === "ticker" ? "ticker" : "global",
    ticker: query.ticker ? normalizeTicker(query.ticker) : undefined,
    exchange: query.exchange ? canonicalExchange(query.exchange) : undefined,
    tickerTier: query.tickerTier ?? (feed === "ticker" ? "primary" : undefined),
    topics,
    categories: topics,
    sectors,
    sources: normalizeStringList(query.sources),
    excludeSources: normalizeStringList(query.excludeSources),
    tickerRelations: normalizeStringList(query.tickerRelations),
    limit: Math.max(1, Math.min(MAX_ARTICLES, query.limit ?? MAX_ARTICLES)),
  };
}

export function createIdleNewsQueryState(): NewsQueryState {
  return {
    phase: "idle",
    articles: [],
    error: null,
    updatedAt: null,
    sourceIds: [],
    nextCursor: null,
    loadingMore: false,
  };
}

function articleKey(item: NewsArticle): string {
  const url = item.url.trim().toLowerCase().replace(/#.*$/, "").replace(/\/$/, "");
  return url || `id:${item.id}`;
}

function sortByPublishedAt(items: NewsArticle[]): NewsArticle[] {
  return [...items].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

function hasStoryItems(item: NewsArticle | null | undefined): boolean {
  return (item?.items?.length ?? 0) > 0;
}

export function markDetailCapableArticle(source: NewsCapability, item: NewsArticle): NewsArticle {
  if (!source.provider.fetchNewsStory) return item;
  Object.defineProperty(item, DETAIL_CAPABLE_ARTICLE, {
    value: true,
    configurable: true,
  });
  return item;
}

function isDetailCapableArticle(item: NewsArticle): boolean {
  return (item as DetailCapableArticle)[DETAIL_CAPABLE_ARTICLE] === true;
}

function shouldReplaceDuplicate(existing: NewsArticle, item: NewsArticle): boolean {
  return (
    item.importance > existing.importance ||
    (item.importance === existing.importance && item.publishedAt > existing.publishedAt)
  );
}

function selectDetailArticle(
  existing: NewsArticle,
  item: NewsArticle,
  winner: NewsArticle,
): NewsArticle | null {
  if (isDetailCapableArticle(winner)) return winner;
  if (isDetailCapableArticle(item)) return item;
  if (isDetailCapableArticle(existing)) return existing;
  if (hasStoryItems(winner)) return winner;
  if (hasStoryItems(item)) return item;
  if (hasStoryItems(existing)) return existing;
  return null;
}

function mergeDuplicateArticle(existing: NewsArticle, item: NewsArticle): NewsArticle {
  const winner = shouldReplaceDuplicate(existing, item)
    ? { ...existing, ...item }
    : existing;
  const detailArticle = selectDetailArticle(existing, item, winner);
  if (!detailArticle || detailArticle.id === winner.id) return winner;
  return {
    ...winner,
    id: detailArticle.id,
    items: hasStoryItems(detailArticle) ? detailArticle.items : winner.items,
  };
}

export function dedupeNewsArticles(items: NewsArticle[]): NewsArticle[] {
  const byKey = new Map<string, NewsArticle>();
  for (const item of items) {
    const key = articleKey(item);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    byKey.set(key, mergeDuplicateArticle(existing, item));
  }
  return sortByPublishedAt([...byKey.values()]).slice(0, MAX_ARTICLES);
}

export function mergeNewsArticle(base: NewsArticle, detail: NewsArticle): NewsArticle {
  const detailItems = detail.items ?? [];
  const baseItems = base.items ?? [];
  return {
    ...base,
    ...detail,
    items: detailItems.length > 0 ? detailItems : baseItems,
  };
}

export function filterNewsArticlesForQuery(items: NewsArticle[], query: NewsQuery): NewsArticle[] {
  let filtered = items;
  if (query.since) {
    const sinceMs = query.since.getTime();
    filtered = filtered.filter((item) => item.publishedAt.getTime() > sinceMs);
  }
  const topics = query.topics ?? query.categories;
  if (topics && topics.length > 0) {
    const topicSet = new Set(topics.map(normalizeNewsCategory));
    filtered = filtered.filter((item) => (
      [item.topic, ...item.topics, ...item.categories].some((topic) => topicSet.has(normalizeNewsCategory(topic)))
    ));
  }
  if (query.sectors && query.sectors.length > 0) {
    const sectorSet = new Set(query.sectors.map(normalizeNewsCategory));
    filtered = filtered.filter((item) => (
      [...item.sectors, ...item.categories].some((sector) => sectorSet.has(normalizeNewsCategory(sector)))
    ));
  }
  if (query.sentiment) {
    filtered = filtered.filter((item) => item.sentiment === query.sentiment);
  }
  if (query.minImportance != null) {
    filtered = filtered.filter((item) => item.scores.importance >= query.minImportance!);
  }
  if (query.minUrgency != null) {
    filtered = filtered.filter((item) => item.scores.urgency >= query.minUrgency!);
  }
  if (query.breaking != null) {
    filtered = filtered.filter((item) => item.isBreaking === query.breaking);
  }
  // Page size is a fetch hint. Accumulated load-more results keep MAX_ARTICLES.
  return filtered.slice(0, MAX_ARTICLES);
}
