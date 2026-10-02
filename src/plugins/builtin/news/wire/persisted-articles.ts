import { useEffect, useMemo } from "react";
import type { MarketNewsItem, NewsStoryItem } from "../../../../types/news-source";
import { usePluginPaneState, usePrunePluginPaneState } from "../../../runtime";

const MAX_PERSISTED_ARTICLES = 200;
const EMPTY_PERSISTED_ARTICLES: PersistedNewsArticle[] = [];

interface PersistedNewsStoryItem extends Omit<NewsStoryItem, "publishedAt"> {
  publishedAt: string;
}

interface PersistedNewsArticle extends Omit<MarketNewsItem, "publishedAt" | "items"> {
  publishedAt: string;
  items?: PersistedNewsStoryItem[];
}

function articleDate(value: Date | string): Date | null {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function serializeStoryItem(item: NewsStoryItem): PersistedNewsStoryItem | null {
  const publishedAt = articleDate(item.publishedAt);
  if (!publishedAt) return null;
  return {
    ...item,
    publishedAt: publishedAt.toISOString(),
  };
}

function serializeArticle(article: MarketNewsItem): PersistedNewsArticle | null {
  const publishedAt = articleDate(article.publishedAt);
  if (!publishedAt) return null;
  return {
    ...article,
    publishedAt: publishedAt.toISOString(),
    items: article.items
      ?.map(serializeStoryItem)
      .filter((item): item is PersistedNewsStoryItem => !!item),
  };
}

function restoreStoryItem(item: PersistedNewsStoryItem): NewsStoryItem | null {
  const publishedAt = articleDate(item.publishedAt);
  if (!publishedAt) return null;
  return {
    ...item,
    publishedAt,
  };
}

function restoreArticle(article: PersistedNewsArticle): MarketNewsItem | null {
  const publishedAt = articleDate(article.publishedAt);
  if (!publishedAt) return null;
  return {
    ...article,
    publishedAt,
    items: article.items
      ?.map(restoreStoryItem)
      .filter((item): item is NewsStoryItem => !!item),
  };
}

function samePersistedArticles(left: PersistedNewsArticle[], right: PersistedNewsArticle[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((article, index) => {
    const other = right[index];
    return other?.id === article.id &&
      other.publishedAt === article.publishedAt &&
      other.source === article.source && other.url === article.url &&
      storyItemsSignature(other.items) === storyItemsSignature(article.items);
  });
}

function storyItemsSignature(items: PersistedNewsStoryItem[] | undefined): string {
  return JSON.stringify(items?.map((item) => [item.id, item.publishedAt, item.sourceName, item.sourceKey, item.url]) ?? []);
}

/**
 * The last fetched articles for `key`, kept in pane state so the pane has
 * something to show on restart before the feed answers.
 *
 * A `keyFamily` names a prefix under which the pane keys one entry per symbol
 * it visits. Only the current member is kept: the feed cache already covers a
 * revisit within the session, and the copy on disk is only ever read for the
 * symbol the pane restarts on. Left alone, a ticker pane accumulated tens of
 * kilobytes per symbol that every pane-state update then copied into the
 * saved layout.
 */
export function usePersistedNewsArticles(
  key: string,
  articles: MarketNewsItem[],
  options: { keyFamily?: string } = {},
): MarketNewsItem[] {
  // Refetch snapshots from before article-level publisher attribution. A new
  // key keeps layouts readable by older clients that expect an article array.
  const storageKey = `${key}:v2`;
  const [persistedArticles, setPersistedArticles] = usePluginPaneState<PersistedNewsArticle[]>(
    storageKey,
    EMPTY_PERSISTED_ARTICLES,
  );
  const pruneSiblings = usePrunePluginPaneState();
  const { keyFamily } = options;
  useEffect(() => {
    pruneSiblings((candidate) => candidate === key
      || (!!keyFamily && candidate !== storageKey && candidate.startsWith(keyFamily)));
  }, [key, storageKey, keyFamily, pruneSiblings]);
  const restoredArticles = useMemo(
    () => persistedArticles.map(restoreArticle).filter((article): article is MarketNewsItem => !!article),
    [persistedArticles],
  );

  useEffect(() => {
    if (articles.length === 0) return;
    const next = articles
      .slice(0, MAX_PERSISTED_ARTICLES)
      .map(serializeArticle)
      .filter((article): article is PersistedNewsArticle => !!article);
    setPersistedArticles((current) => samePersistedArticles(current, next) ? current : next);
  }, [articles, setPersistedArticles]);

  return articles.length > 0 ? articles : restoredArticles;
}
