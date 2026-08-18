import type { NewsCapability } from "../capabilities";
import type { ConnectionHealthRegistry } from "../core/connection-health";
import type { NewsArticle, NewsQuery, NewsQueryState } from "./types";
import {
  DEFAULT_GLOBAL_QUERY,
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
  pollIntervalMs?: number;
  inactiveQueryTtlMs?: number;
  maxInactiveQueries?: number;
  now?: () => number;
  connectionHealth?: ConnectionHealthRegistry;
}

export type NewsQueryListener = (state: NewsQueryState) => void;

const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_INACTIVE_QUERY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_INACTIVE_QUERIES = 50;

interface SourceFetchResult {
  articles: NewsArticle[];
  sourceIds: string[];
}

interface NewsQueryEntry {
  query: NewsQuery;
  state: NewsQueryState;
  inFlight: Promise<NewsQueryState> | null;
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
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;
  private readonly inactiveQueryTtlMs: number;
  private readonly maxInactiveQueries: number;
  private readonly now: () => number;
  private readonly connectionHealth?: ConnectionHealthRegistry;

  constructor(options: NewsServiceOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.inactiveQueryTtlMs = Math.max(1, options.inactiveQueryTtlMs ?? DEFAULT_INACTIVE_QUERY_TTL_MS);
    this.maxInactiveQueries = Math.max(1, Math.floor(options.maxInactiveQueries ?? DEFAULT_MAX_INACTIVE_QUERIES));
    this.now = options.now ?? Date.now;
    this.connectionHealth = options.connectionHealth;
  }

  register(source: NewsCapability): () => void {
    this.sources.set(source.id, source);
    this.seedCachedSource(source);
    if (this.pollTimer !== null) {
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
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => void this.pollActiveQueries(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
    emit();
    void this.refreshQuery(normalized, false);

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
        const articles = filterNewsArticlesForQuery(dedupeNewsArticles(result.articles), query);
        const state: NewsQueryState = {
          phase: "ready",
          articles,
          error: null,
          updatedAt: this.now(),
          sourceIds: result.sourceIds,
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
    if (normalizeNewsFeed(query) === "ticker") {
      return this.fetchTickerNews(query, sources);
    }
    return this.fetchMergedNews(query, sources);
  }

  private async fetchTickerNews(query: NewsQuery, sources: NewsCapability[]): Promise<SourceFetchResult> {
    let firstEmpty: SourceFetchResult | null = null;
    for (const source of sources) {
      try {
        const articles = (await this.trackSourceRequest(
          source,
          "fetchNews",
          () => source.provider.fetchNews(query),
        )).map((article) => markDetailCapableArticle(source, article));
        const result = { articles, sourceIds: [newsCapabilitySourceId(source)] };
        if (articles.length > 0) return result;
        firstEmpty ??= result;
      } catch {
        // Continue to lower-priority sources.
      }
    }
    return firstEmpty ?? { articles: [], sourceIds: [] };
  }

  private async fetchMergedNews(query: NewsQuery, sources: NewsCapability[]): Promise<SourceFetchResult> {
    const settled = await Promise.allSettled(
      sources.map(async (source) => ({
        source,
        articles: (await this.trackSourceRequest(
          source,
          "fetchNews",
          () => source.provider.fetchNews(query),
        )).map((article) => markDetailCapableArticle(source, article)),
      })),
    );
    const articles: NewsArticle[] = [];
    const sourceIds: string[] = [];
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      articles.push(...result.value.articles);
      sourceIds.push(newsCapabilitySourceId(result.value.source));
    }
    return { articles, sourceIds };
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
