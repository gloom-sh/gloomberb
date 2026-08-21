import type { NewsCapability } from "../capabilities";
import type { ConnectionHealthRegistry } from "../core/connection-health";
import type { NewsArticle, NewsQuery, NewsQueryState } from "./types";
import {
  DEFAULT_GLOBAL_QUERY,
  MAX_ARTICLES,
  buildNewsQueryKey,
  createIdleNewsQueryState,
  dedupeNewsArticles,
  filterNewsArticlesForQuery,
  markDetailCapableArticle,
  mergeNewsArticle,
  normalizeNewsCategory,
  normalizeNewsFeed,
  normalizeNewsQuery,
} from "./news-model";

export { buildNewsQueryKey } from "./news-model";

export interface NewsServiceOptions {
  /** Pass a function to follow the user's configured refresh interval. */
  pollIntervalMs?: number | (() => number);
  inactiveQueryTtlMs?: number;
  maxInactiveQueries?: number;
  now?: () => number;
  connectionHealth?: ConnectionHealthRegistry;
}

export type NewsQueryListener = (state: NewsQueryState) => void;

const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 15 * 1000;
const DEFAULT_INACTIVE_QUERY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_INACTIVE_QUERIES = 50;

interface SourceFetchResult {
  articles: NewsArticle[];
  sourceIds: string[];
  failedSourceIds: string[];
  nextCursor: string | null;
}

interface NewsQueryEntry {
  query: NewsQuery;
  state: NewsQueryState;
  inFlight: Promise<NewsQueryState> | null;
  loadMoreInFlight: Promise<void> | null;
  refs: number;
  lastAccessedAt: number;
}

function newsCapabilityPriority(source: NewsCapability): number {
  return source.priority ?? 1000;
}

function newsCapabilitySourceId(source: NewsCapability): string {
  return source.sourceId ?? source.id;
}

export class NewsService {
  private readonly sources = new Map<string, NewsCapability>();
  private readonly listeners = new Set<() => void>();
  private readonly queries = new Map<string, NewsQueryEntry>();
  private articles: NewsArticle[] = [];
  private version = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private readonly pollIntervalMs: () => number;
  private readonly inactiveQueryTtlMs: number;
  private readonly maxInactiveQueries: number;
  private readonly now: () => number;
  private readonly connectionHealth?: ConnectionHealthRegistry;

  constructor(options: NewsServiceOptions = {}) {
    const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollIntervalMs = typeof pollInterval === "function" ? pollInterval : () => pollInterval;
    this.inactiveQueryTtlMs = Math.max(1, options.inactiveQueryTtlMs ?? DEFAULT_INACTIVE_QUERY_TTL_MS);
    this.maxInactiveQueries = Math.max(1, Math.floor(options.maxInactiveQueries ?? DEFAULT_MAX_INACTIVE_QUERIES));
    this.now = options.now ?? Date.now;
    this.connectionHealth = options.connectionHealth;
  }

  register(source: NewsCapability): () => void {
    this.sources.set(source.id, source);
    this.seedCachedSource(source);
    if (this.polling) {
      void this.pollActiveQueries();
    }
    return () => {
      if (this.sources.get(source.id) === source) {
        this.unregister(source.id);
      }
    };
  }

  unregister(sourceId: string): void {
    this.sources.delete(sourceId);
  }

  start(): void {
    if (this.polling) return;
    this.polling = true;
    this.scheduleNextPoll();
  }

  stop(): void {
    this.polling = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Rescheduled every cycle so a config change takes effect on the next tick. */
  private scheduleNextPoll(): void {
    if (!this.polling) return;
    const interval = Math.max(MIN_POLL_INTERVAL_MS, this.pollIntervalMs());
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollActiveQueries().catch(() => {}).then(() => this.scheduleNextPoll());
    }, interval);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  watchQuery(query: NewsQuery, listener: NewsQueryListener): () => void {
    const normalized = normalizeNewsQuery(query);
    const key = buildNewsQueryKey(normalized);
    const entry = this.getOrCreateQueryEntry(normalized);
    entry.refs++;

    const emit = () => listener(this.queries.get(key)?.state ?? createIdleNewsQueryState());
    const unsubscribe = this.subscribe(emit);
    // Show loading before emitting: the fetch below starts immediately, and an
    // idle first frame paints an empty pane instead of a loading one.
    void this.refreshQuery(normalized, true);
    emit();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      const current = this.queries.get(key);
      if (!current) return;
      current.refs = Math.max(0, current.refs - 1);
      current.lastAccessedAt = this.now();
      this.pruneInactiveQueries();
    };
  }

  getVersion(): number {
    return this.version;
  }

  private notify(): void {
    this.version++;
    for (const listener of this.listeners) {
      listener();
    }
  }

  getQueryState(query: NewsQuery): NewsQueryState {
    const normalized = normalizeNewsQuery(query);
    return this.getOrCreateQueryEntry(normalized).state;
  }

  async load(query: NewsQuery): Promise<NewsQueryState> {
    return this.refreshQuery(normalizeNewsQuery(query), true);
  }

  async loadMore(query: NewsQuery): Promise<void> {
    const normalized = normalizeNewsQuery(query);
    const entry = this.queries.get(buildNewsQueryKey(normalized));
    if (!entry || entry.loadMoreInFlight || !entry.state.nextCursor || entry.state.loadingMore) return;
    if (entry.state.articles.length >= MAX_ARTICLES) {
      entry.state = { ...entry.state, nextCursor: null };
      this.notify();
      return;
    }

    const request = (async () => {
      entry.state = { ...entry.state, loadingMore: true };
      this.notify();
      try {
        const result = await this.fetchFromSources({
          ...normalized,
          cursor: entry.state.nextCursor ?? undefined,
        });
        entry.state = {
          ...entry.state,
          loadingMore: false,
          articles: filterNewsArticlesForQuery(
            dedupeNewsArticles([...entry.state.articles, ...result.articles]),
            normalized,
          ),
          nextCursor: result.nextCursor,
        };
        this.rebuildArticlePool();
        this.notify();
      } catch {
        entry.state = { ...entry.state, loadingMore: false };
        this.notify();
      } finally {
        entry.loadMoreInFlight = null;
      }
    })();
    entry.loadMoreInFlight = request;
    await request;
  }

  async loadStory(storyId: string): Promise<NewsArticle | null> {
    const sources = this.enabledSources({ feed: "latest" })
      .filter((source) => !!source.provider.fetchNewsStory);

    for (const source of sources) {
      try {
        const article = await this.trackSourceRequest(
          source,
          "fetchNewsStory",
          () => source.provider.fetchNewsStory?.(storyId) ?? Promise.resolve(null),
        );
        if (!article) continue;
        this.mergeStoryDetail(article);
        return article;
      } catch {
        // Continue to lower-priority sources.
      }
    }

    return null;
  }

  async poll(query: NewsQuery = DEFAULT_GLOBAL_QUERY): Promise<void> {
    await this.refreshQuery(normalizeNewsQuery(query), false);
  }

  private async pollActiveQueries(): Promise<void> {
    this.pruneInactiveQueries();
    const queries = [...this.queries.values()]
      .filter((entry) => entry.refs > 0)
      .map((entry) => entry.query);
    if (queries.length === 0) return;
    await Promise.allSettled(queries.map((query) => this.refreshQuery(query, false)));
  }

  private async refreshQuery(
    query: NewsQuery,
    showLoading: boolean,
  ): Promise<NewsQueryState> {
    const entry = this.getOrCreateQueryEntry(query);
    if (entry.inFlight) return entry.inFlight;

    const current = entry.state;
    if (showLoading) {
      entry.state = {
        ...current,
        phase: current.articles.length > 0 ? "refreshing" : "loading",
        error: null,
      };
      this.notify();
    }

    const promise = (async () => {
      try {
        const result = await this.fetchFromSources(query);
        if (result.sourceIds.length === 0 && result.failedSourceIds.length > 0) {
          throw new Error("News sources unavailable.");
        }
        if (entry.loadMoreInFlight) return entry.state;
        const incoming = filterNewsArticlesForQuery(dedupeNewsArticles(result.articles), query);
        const existing = entry.state.articles;
        const incomingIds = new Set(incoming.map((article) => article.id));
        const hasOlderPages = existing.some((article) => !incomingIds.has(article.id));
        const articles = existing.length > 0
          ? filterNewsArticlesForQuery(dedupeNewsArticles([...incoming, ...existing]), query)
          : incoming;
        const state: NewsQueryState = {
          phase: "ready",
          articles,
          // A partial failure still has stories, so it stays ready and reports
          // the gap instead of pretending the feed is complete.
          error: result.failedSourceIds.length > 0
            ? `${result.failedSourceIds.length} of ${result.failedSourceIds.length + result.sourceIds.length} news sources unavailable.`
            : null,
          updatedAt: this.now(),
          sourceIds: result.sourceIds,
          nextCursor: hasOlderPages ? entry.state.nextCursor : result.nextCursor,
          loadingMore: entry.state.loadingMore,
        };
        entry.state = state;
        entry.lastAccessedAt = this.now();
        this.rebuildArticlePool();
        this.notify();
        return state;
      } catch (error) {
        const state: NewsQueryState = {
          ...current,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        };
        entry.state = state;
        entry.lastAccessedAt = this.now();
        this.notify();
        return state;
      } finally {
        entry.inFlight = null;
        this.pruneInactiveQueries();
      }
    })();

    entry.inFlight = promise;
    return promise;
  }

  private getOrCreateQueryEntry(query: NewsQuery): NewsQueryEntry {
    const key = buildNewsQueryKey(query);
    const now = this.now();
    this.pruneInactiveQueries(now);
    const existing = this.queries.get(key);
    if (existing) {
      existing.lastAccessedAt = now;
      return existing;
    }
    const entry: NewsQueryEntry = {
      query,
      state: createIdleNewsQueryState(),
      inFlight: null,
      loadMoreInFlight: null,
      refs: 0,
      lastAccessedAt: now,
    };
    this.queries.set(key, entry);
    this.pruneInactiveQueries(now);
    return entry;
  }

  private pruneInactiveQueries(now = this.now()): void {
    const inactive = [...this.queries.entries()]
      .filter(([, entry]) => entry.refs === 0 && entry.inFlight === null)
      .sort((left, right) => right[1].lastAccessedAt - left[1].lastAccessedAt);

    let retained = 0;
    let changed = false;
    for (const [key, entry] of inactive) {
      const expired = now - entry.lastAccessedAt >= this.inactiveQueryTtlMs;
      if (expired || retained >= this.maxInactiveQueries) {
        this.queries.delete(key);
        changed = true;
      } else {
        retained++;
      }
    }
    if (changed) this.rebuildArticlePool();
  }

  private enabledSources(query: NewsQuery): NewsCapability[] {
    return [...this.sources.values()]
      .filter((source) => source.isEnabled?.() !== false)
      .filter((source) => source.provider.supports?.(query) ?? true)
      .sort((a, b) => newsCapabilityPriority(a) - newsCapabilityPriority(b));
  }

  private async fetchFromSources(query: NewsQuery): Promise<SourceFetchResult> {
    const sources = this.enabledSources(query);
    const pageSources = query.cursor
      ? sources.filter((source) => !!source.provider.fetchNewsPage)
      : sources;
    if (normalizeNewsFeed(query) === "ticker") {
      return this.fetchTickerNews(query, pageSources);
    }
    return this.fetchMergedNews(query, pageSources);
  }

  private async readSourcePage(
    source: NewsCapability,
    query: NewsQuery,
  ): Promise<{ articles: NewsArticle[]; nextCursor: string | null }> {
    if (source.provider.fetchNewsPage) {
      const page = await this.trackSourceRequest(
        source,
        "fetchNewsPage",
        () => source.provider.fetchNewsPage!(query),
      );
      return {
        articles: page.articles.map((article) => markDetailCapableArticle(source, article)),
        nextCursor: page.nextCursor ?? null,
      };
    }
    const articles = (await this.trackSourceRequest(
      source,
      "fetchNews",
      () => source.provider.fetchNews(query),
    )).map((article) => markDetailCapableArticle(source, article));
    return { articles, nextCursor: null };
  }

  private async fetchTickerNews(query: NewsQuery, sources: NewsCapability[]): Promise<SourceFetchResult> {
    let firstEmpty: SourceFetchResult | null = null;
    const failedSourceIds: string[] = [];
    for (const source of sources) {
      try {
        const page = await this.readSourcePage(source, query);
        const result = {
          articles: page.articles,
          sourceIds: [newsCapabilitySourceId(source)],
          failedSourceIds,
          nextCursor: page.nextCursor,
        };
        if (page.articles.length > 0) return result;
        firstEmpty ??= result;
      } catch {
        failedSourceIds.push(newsCapabilitySourceId(source));
      }
    }
    return firstEmpty ?? { articles: [], sourceIds: [], failedSourceIds, nextCursor: null };
  }

  private async fetchMergedNews(query: NewsQuery, sources: NewsCapability[]): Promise<SourceFetchResult> {
    const settled = await Promise.allSettled(
      sources.map(async (source) => ({
        source,
        page: await this.readSourcePage(source, query),
      })),
    );
    const articles: NewsArticle[] = [];
    const sourceIds: string[] = [];
    const failedSourceIds: string[] = [];
    let nextCursor: string | null = null;
    settled.forEach((result, index) => {
      if (result.status !== "fulfilled") {
        const source = sources[index];
        if (source) failedSourceIds.push(newsCapabilitySourceId(source));
        return;
      }
      articles.push(...result.value.page.articles);
      sourceIds.push(newsCapabilitySourceId(result.value.source));
      nextCursor ??= result.value.page.nextCursor;
    });
    return { articles, sourceIds, failedSourceIds, nextCursor };
  }

  private trackSourceRequest<T>(
    source: NewsCapability,
    operation: string,
    request: () => Promise<T>,
  ): Promise<T> {
    return this.connectionHealth?.hasSource(source.id)
      ? this.connectionHealth.track(source.id, operation, request)
      : request();
  }

  private seedCachedSource(source: NewsCapability): void {
    const news = source.provider;
    const queries = [...this.queries.values()].map((entry) => entry.query);
    if (queries.length === 0) queries.push(DEFAULT_GLOBAL_QUERY);

    let changed = false;
    for (const query of queries) {
      if (source.isEnabled?.() === false || news.supports?.(query) === false) continue;
      const cached = (news.getCachedNews?.(query) ?? [])
        .map((article) => markDetailCapableArticle(source, article));
      if (cached.length === 0) continue;
      const entry = this.getOrCreateQueryEntry(query);
      entry.state = {
        phase: "ready",
        articles: filterNewsArticlesForQuery(dedupeNewsArticles([...entry.state.articles, ...cached]), query),
        error: null,
        updatedAt: this.now(),
        sourceIds: [...new Set([...entry.state.sourceIds, newsCapabilitySourceId(source)])],
        nextCursor: entry.state.nextCursor,
        loadingMore: false,
      };
      changed = true;
    }
    if (changed) {
      this.rebuildArticlePool();
      this.notify();
    }
  }

  private rebuildArticlePool(): void {
    this.articles = dedupeNewsArticles([...this.queries.values()].flatMap((entry) => entry.state.articles));
  }

  private mergeStoryDetail(article: NewsArticle): void {
    let changed = false;
    for (const entry of this.queries.values()) {
      let stateChanged = false;
      const nextArticles = entry.state.articles.map((existing) => {
        if (existing.id !== article.id) return existing;
        stateChanged = true;
        changed = true;
        return mergeNewsArticle(existing, article);
      });
      if (stateChanged) {
        entry.state = { ...entry.state, articles: nextArticles };
      }
    }

    if (!changed) return;
    this.rebuildArticlePool();
    this.notify();
  }

  getTopStories(count = 20): NewsArticle[] {
    return [...this.articles]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, count);
  }

  getFirehose(since?: Date, count = 100): NewsArticle[] {
    let items = this.articles;
    if (since) {
      const sinceMs = since.getTime();
      items = items.filter((item) => item.publishedAt.getTime() > sinceMs);
    }
    // articles is already sorted by publishedAt descending
    return items.slice(0, count);
  }

  getBySector(sector: string, count = 50): NewsArticle[] {
    const normalizedSector = normalizeNewsCategory(sector);
    return this.articles
      .filter((item) => [...item.sectors, ...item.categories].some((category) => normalizeNewsCategory(category) === normalizedSector))
      .slice(0, count);
  }

  getBreaking(count = 20): NewsArticle[] {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return this.articles
      .filter(
        (item) =>
          item.isBreaking ||
          (item.publishedAt.getTime() >= oneHourAgo && item.importance >= 70),
      )
      .slice(0, count);
  }
}
