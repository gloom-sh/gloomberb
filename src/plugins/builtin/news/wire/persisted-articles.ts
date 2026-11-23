import { useEffect, useMemo, useSyncExternalStore } from "react";
import { apiClient } from "../../../../api-client";
import { cloudNewsSnapshotScope } from "../../../../news/cloud-session";
import { usePaneInstance } from "../../../../state/app/context";
import type { MarketNewsItem, NewsStoryItem } from "../../../../types/news-source";
import { usePluginPaneState } from "../../../runtime";
import { usePluginRenderContext } from "../../../runtime/context";
import { useSavedCopyFooter } from "../../../../components/layout/pane/footer/registration";
import { retrievedAtOf } from "../../../../data/saved-copies";

const MAX_PERSISTED_ARTICLES = 200;
const EMPTY_PERSISTED_ARTICLES: PersistedNewsArticle[] = [];

interface PersistedNewsStoryItem extends Omit<NewsStoryItem, "publishedAt"> {
  publishedAt: string;
}

type NewsRoutineNotices = NonNullable<MarketNewsItem["routine"]>;

interface PersistedNewsRoutineNotices extends Omit<NewsRoutineNotices, "since"> {
  since: string;
}

interface PersistedNewsArticle extends Omit<MarketNewsItem, "publishedAt" | "items" | "routine"> {
  publishedAt: string;
  items?: PersistedNewsStoryItem[];
  routine?: PersistedNewsRoutineNotices;
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

/** A folded row's notices with their first day as text, as pane state keeps dates; none when that day is unreadable. */
function serializeRoutine(routine: NewsRoutineNotices | undefined): PersistedNewsRoutineNotices | undefined {
  const since = routine ? articleDate(routine.since) : null;
  return routine && since ? { ...routine, since: since.toISOString() } : undefined;
}

/** A folded row's notices as restored: their first day a Date again, or none when it cannot be read. */
function restoreRoutine(routine: PersistedNewsRoutineNotices | NewsRoutineNotices | undefined): NewsRoutineNotices | undefined {
  const since = routine ? articleDate(routine.since) : null;
  return routine && since ? { ...routine, since } : undefined;
}

function serializeArticle(article: MarketNewsItem): PersistedNewsArticle | null {
  const publishedAt = articleDate(article.publishedAt);
  if (!publishedAt) return null;
  const { routine: _routine, ...rest } = article;
  const routine = serializeRoutine(article.routine);
  return {
    ...rest,
    publishedAt: publishedAt.toISOString(),
    items: article.items
      ?.map(serializeStoryItem)
      .filter((item): item is PersistedNewsStoryItem => !!item),
    ...(routine ? { routine } : {}),
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
  const { routine: _routine, ...rest } = article;
  const routine = restoreRoutine(article.routine);
  return {
    ...rest,
    publishedAt,
    items: article.items
      ?.map(restoreStoryItem)
      .filter((item): item is NewsStoryItem => !!item),
    ...(routine ? { routine } : {}),
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

function restoreArticles(articles: PersistedNewsArticle[]): MarketNewsItem[] {
  return articles.map(restoreArticle).filter((article): article is MarketNewsItem => !!article);
}

function serializeArticles(articles: MarketNewsItem[]): PersistedNewsArticle[] {
  return articles.slice(0, MAX_PERSISTED_ARTICLES).map(serializeArticle)
    .filter((article): article is PersistedNewsArticle => !!article);
}

const subscribeToSession = (listener: () => void) => apiClient.subscribeCurrentUser(listener);

export function usePersistedNewsArticles(key: string, articles: MarketNewsItem[], refreshFailed = false): MarketNewsItem[] {
  const { pluginId, runtime } = usePluginRenderContext();
  const pane = usePaneInstance();
  const scope = useSyncExternalStore(subscribeToSession, cloudNewsSnapshotScope, cloudNewsSnapshotScope);
  const snapshots = runtime.newsPaneSnapshots;
  const storageKey = `${key}:v2`;
  const cached = useMemo(() => {
    if (articles.length || !pane) return null;
    const saved = snapshots?.read<PersistedNewsArticle>(pane, pluginId, storageKey, scope);
    return saved ? { articles: restoreArticles(saved), fetchedAt: retrievedAtOf(saved) } : null;
  }, [articles, pane, pluginId, scope, snapshots, storageKey]);
  useSavedCopyFooter(refreshFailed && cached?.articles.length ? cached.fetchedAt : null, false);
  useEffect(() => {
    if (articles.length && pane && scope != null) {
      snapshots?.write(pane, pluginId, storageKey, scope, serializeArticles(articles));
    }
  }, [articles, pane, pluginId, scope, snapshots, storageKey]);
  return articles.length ? articles : cached?.articles ?? [];
}

export function usePersistedStory(articles: MarketNewsItem[]): MarketNewsItem[] {
  const [persistedArticles, setPersistedArticles] = usePluginPaneState("story:v2", EMPTY_PERSISTED_ARTICLES);
  const restoredArticles = useMemo(() => restoreArticles(persistedArticles), [persistedArticles]);
  useEffect(() => {
    if (articles.length === 0) return;
    const next = serializeArticles(articles);
    setPersistedArticles((current) => samePersistedArticles(current, next) ? current : next);
  }, [articles, setPersistedArticles]);

  return articles.length > 0 ? articles : restoredArticles;
}
