/**
 * Where the DOCS pane gets its text. The index comes from gloom.sh, read at
 * most every few hours and kept; the copy that ships with the app covers a
 * first start and a machine that is offline. A lesson is read when it is
 * opened and kept the same way, so a lesson read once stays readable.
 */
import { createPluginCache } from "../data/plugin-cache";
import type { PluginPersistence } from "../types/plugin";
import { createThrottledFetch } from "../utils/throttled-fetch";
import {
  DOCS_FEED_URL,
  docsLessonFeedUrl,
  parseDocsFeed,
  parseDocsLesson,
  type DocsFeed,
  type DocsLesson,
} from "./content";

const HOUR_MS = 60 * 60_000;
const YEAR_MS = 365 * 24 * HOUR_MS;
const FEED_KEY = "index";

const docsFetch = createThrottledFetch({
  requestsPerMinute: 20,
  maxRetries: 1,
  timeoutMs: 10_000,
  backoffBaseMs: 500,
  dedupeGetRequests: true,
  defaultHeaders: { Accept: "application/json" },
});

const feedCache = createPluginCache<DocsFeed>({
  kind: "docs-index",
  source: "gloom-site",
  policy: { staleMs: 6 * HOUR_MS, expireMs: YEAR_MS },
  decode: (value) => {
    const feed = parseDocsFeed({ format: 1, ...(value as object) });
    if (!feed) throw new Error("Unreadable saved docs");
    return feed;
  },
});

const lessonCache = createPluginCache<DocsLesson>({
  kind: "docs-lesson",
  source: "gloom-site",
  policy: { staleMs: 24 * HOUR_MS, expireMs: YEAR_MS },
  decode: (value) => {
    const lesson = parseDocsLesson({ format: 1, ...(value as object) });
    if (!lesson) throw new Error("Unreadable saved lesson");
    return lesson;
  },
});

export function attachDocsPersistence(persistence: PluginPersistence): void {
  feedCache.attach(persistence);
  lessonCache.attach(persistence);
}

export function resetDocsPersistence(): void {
  feedCache.reset();
  lessonCache.reset();
}

type FetchJson = (url: string) => Promise<unknown>;

const siteFetchJson: FetchJson = async (url) => {
  const response = await docsFetch.fetch(url);
  if (!response.ok) throw new Error(`gloom.sh returned ${response.status}`);
  return response.json();
};

let fetchJson = siteFetchJson;

/** Tests read a fixed site, or none; null restores the real one. */
export function setDocsFetchForTests(next: FetchJson | null): void {
  fetchJson = next ?? siteFetchJson;
}

let snapshot: Promise<DocsFeed> | null = null;

/** The copy that ships with the app. Loaded on first use: the web build keeps it out of the startup bundle. */
function loadDocsSnapshot(): Promise<DocsFeed> {
  snapshot ??= import("./snapshot.chunk.js").then(({ DOCS_SNAPSHOT }) => {
    const feed = parseDocsFeed(DOCS_SNAPSHOT);
    if (!feed) throw new Error("The docs that ship with the app are unreadable.");
    return feed;
  });
  return snapshot;
}

export interface DocsFeedResult {
  feed: DocsFeed;
  /** The site could not be read; this is the saved or shipped copy. */
  offline: boolean;
}

/** A saved copy older than the one the app shipped with loses to it. */
function newer(saved: DocsFeed | null, shipped: DocsFeed): DocsFeed {
  return saved && saved.updatedAt >= shipped.updatedAt ? saved : shipped;
}

/** The index as last read, without waiting on the network; null before the first read. */
export function savedDocsFeed(): DocsFeed | null {
  return feedCache.get(FEED_KEY, { allowExpired: true })?.data ?? null;
}

/**
 * The freshest index this machine can have: the saved one while it is
 * recent, otherwise the site's, otherwise the saved or shipped copy marked
 * offline. Never rejects.
 */
export async function loadDocsFeed({ force = false }: { force?: boolean } = {}): Promise<DocsFeedResult> {
  const shipped = await loadDocsSnapshot();
  try {
    const result = await feedCache.load(FEED_KEY, async () => {
      const feed = parseDocsFeed(await fetchJson(DOCS_FEED_URL));
      if (!feed) throw new Error("gloom.sh sent docs this version cannot read");
      return feed;
    }, { force });
    return { feed: newer(result.data, shipped), offline: result.source === "stale-fallback" };
  } catch {
    return { feed: newer(savedDocsFeed(), shipped), offline: true };
  }
}

/** A lesson, from the site or as last read. Rejects when it was never read and the site cannot be reached. */
export async function loadDocsLesson(url: string, { force = false }: { force?: boolean } = {}): Promise<{ lesson: DocsLesson; offline: boolean }> {
  const result = await lessonCache.load(url, async () => {
    const lesson = parseDocsLesson(await fetchJson(docsLessonFeedUrl(url)));
    if (!lesson) throw new Error("gloom.sh sent a lesson this version cannot read");
    return lesson;
  }, { force });
  return { lesson: result.data, offline: result.source === "stale-fallback" };
}

/** A lesson already read, for a first frame that does not flash a loading state. */
export function savedDocsLesson(url: string): DocsLesson | null {
  return lessonCache.get(url, { allowExpired: true })?.data ?? null;
}
