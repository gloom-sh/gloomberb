import type { PersistedResourceValue } from "../../../../types/persistence";
import {
  sortSubscriptionsByLatest,
} from "../normalize";
import type {
  SubstackArticleDetail,
  SubstackArticleSummary,
  SubstackPublication,
} from "../types";
import type { SubstackCachedData, SubstackHomeData, SubstackPublicationFeedPage } from "./types";
import { readResource } from "./store";

const PUBLICATION_ARCHIVE_MAX_CACHED_PAGES = 20;

export function publicationCacheKey(publication: SubstackPublication, offset: number): string {
  return `${publication.baseUrl ?? publication.subdomain ?? publication.id}:offset:${offset}`;
}

function cachedDataFromResource<T>(entry: PersistedResourceValue<T> | null): SubstackCachedData<T> | null {
  if (!entry) return null;
  return {
    data: entry.value,
    fetchedAt: entry.fetchedAt,
    stale: Boolean(entry.stale),
  };
}

export function getCachedSubstackHome(): SubstackHomeData | null {
  const subscriptionsEntry = readResource<SubstackPublication[]>("subscriptions", "me", false);
  const feedEntry = readResource<SubstackArticleSummary[] | { items: SubstackArticleSummary[]; nextCursor?: string | null }>("feed", "subscribed", false);
  if (!subscriptionsEntry || !feedEntry) return null;
  const feed = Array.isArray(feedEntry.value) ? feedEntry.value : feedEntry.value.items;
  const nextCursor = Array.isArray(feedEntry.value) ? null : feedEntry.value.nextCursor ?? null;
  return {
    subscriptions: sortSubscriptionsByLatest(subscriptionsEntry.value, feed),
    feed,
    fetchedAt: Math.max(subscriptionsEntry.fetchedAt, feedEntry.fetchedAt),
    stale: Boolean(subscriptionsEntry.stale) || Boolean(feedEntry.stale),
    hasMore: !!nextCursor,
    nextCursor,
  };
}

export function getCachedSubstackPublicationFeed(
  publication: SubstackPublication,
): SubstackCachedData<SubstackPublicationFeedPage> | null {
  let offset: number | null = 0;
  let pageCount = 0;
  let merged: SubstackPublicationFeedPage | null = null;
  let fetchedAt = 0;
  let stale = false;

  while (offset != null && pageCount < PUBLICATION_ARCHIVE_MAX_CACHED_PAGES) {
    const entry: PersistedResourceValue<SubstackPublicationFeedPage> | null = readResource<SubstackPublicationFeedPage>(
      "publication",
      publicationCacheKey(publication, offset),
      false,
    );
    if (!entry) break;
    const itemsById = new Map<string, SubstackArticleSummary>();
    for (const article of merged?.items ?? []) itemsById.set(article.id, article);
    for (const article of entry.value.items) itemsById.set(article.id, article);
    merged = {
      items: [...itemsById.values()],
      nextOffset: entry.value.nextOffset,
      hasMore: entry.value.hasMore,
    };
    fetchedAt = Math.max(fetchedAt, entry.fetchedAt);
    stale = stale || Boolean(entry.stale);
    offset = entry.value.nextOffset;
    pageCount += 1;
  }

  if (!merged) return null;
  return { data: merged, fetchedAt, stale };
}

export function getCachedSubstackArticleDetail(
  article: Pick<SubstackArticleSummary, "id">,
): SubstackCachedData<SubstackArticleDetail> | null {
  return cachedDataFromResource(readResource<SubstackArticleDetail>("post", article.id, false));
}
