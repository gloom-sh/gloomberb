import type { NewsArticle, NewsQuery } from "../../../../news/types";
import { getSharedNewsService } from "../../../../news/hooks";
import { apiClient } from "../../../../api-client";
import { mapCloudNewsArticle } from "../../../../sources/gloomberb-cloud/news";

const ARTICLE_SEARCH_LIMIT = 8;

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "on",
  "of",
  "in",
  "to",
  "for",
  "and",
  "or",
  "from",
  "with",
  "about",
  "by",
  "at",
  "as",
  "is",
  "are",
  "was",
  "be",
]);

const INTENT_WORDS = new Set([
  "article",
  "articles",
  "news",
  "headline",
  "headlines",
  "story",
  "stories",
  "rss",
  "feed",
  "feeds",
  "press",
]);

const COMMAND_WORDS = new Set([
  "open",
  "read",
  "show",
  "find",
  "search",
  "please",
  "me",
  "latest",
  "recent",
  "lookup",
  "look",
  "up",
]);

/** Pulls the freshest slice of the global feed to search over. */
export const ARTICLE_SEARCH_QUERY: NewsQuery = { feed: "latest", limit: 200 };

export function tokenizeArticleQuery(query: string): string[] {
  // `ART trump` is the command prefix plus a topic — "art" is not a search term.
  const withoutArtPrefix = query.replace(/^\s*art\b/i, " ");
  return withoutArtPrefix
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => (
      token.length >= 2
      && !STOPWORDS.has(token)
      && !INTENT_WORDS.has(token)
      && !COMMAND_WORDS.has(token)
    ));
}

export function looksLikeArticleQuery(query: string): boolean {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((token) => INTENT_WORDS.has(token))) return true;
  return /^\s*art\b/i.test(query);
}

export function scoreArticleMatch(article: NewsArticle, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const title = article.title.toLowerCase();
  const source = article.source.toLowerCase();
  const haystack = [
    title,
    source,
    article.summary ?? "",
    ...article.topics,
    ...article.categories,
    ...article.tickers,
  ].join(" ").toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 10;
    else if (source.includes(token)) score += 6;
    else if (haystack.includes(token)) score += 3;
    else return 0;
  }
  return score;
}

export function searchNewsArticles(
  articles: readonly NewsArticle[],
  query: string,
  limit = ARTICLE_SEARCH_LIMIT,
): NewsArticle[] {
  const tokens = tokenizeArticleQuery(query);
  if (tokens.length === 0) {
    return [...articles]
      .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime())
      .slice(0, limit);
  }

  return articles
    .map((article) => ({ article, score: scoreArticleMatch(article, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.article.publishedAt.getTime() - left.article.publishedAt.getTime();
    })
    .slice(0, limit)
    .map((entry) => entry.article);
}

/** Headlines already sitting in the shared news pool (firehose/RSS/breaking). */
export function cachedNewsArticles(): NewsArticle[] {
  const service = getSharedNewsService();
  if (!service) return [];
  const pooled = service.getFirehose(undefined, 500);
  if (pooled.length > 0) return pooled;
  return service.getQueryState(ARTICLE_SEARCH_QUERY).articles;
}

export async function loadNewsArticles(): Promise<NewsArticle[]> {
  const service = getSharedNewsService();
  if (!service) return [];
  return (await service.load(ARTICLE_SEARCH_QUERY)).articles;
}

export async function searchCloudNewsArticles(query: string): Promise<NewsArticle[]> {
  const search = tokenizeArticleQuery(query).join(" ");
  if (!search) return [];
  const response = await apiClient.searchCloudNews(search, ARTICLE_SEARCH_LIMIT);
  return response.items.map((item) => mapCloudNewsArticle(item));
}
