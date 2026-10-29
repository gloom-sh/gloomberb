import type { CompanyFrom } from "../types/company-from";
import { logFailure } from "../utils/log-failure";
import type { NewsCapability } from "../capabilities";
import type { ConnectionHealthRegistry } from "../core/connection-health";
import type { NewsAccess, NewsArticle, NewsQuery, NewsQueryState } from "./types";
import { isAppVisible, subscribeAppVisibility } from "../state/app/activity";
import {
  DEFAULT_GLOBAL_QUERY,
  MAX_ARTICLES,
  buildNewsQueryKey,
  createIdleNewsQueryState,
  dedupeNewsArticles,
  filterNewsArticlesForQuery,
  markDetailCapableArticle,
  mergeNewsArticle,
  newsArticleRevision,
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
  /** Defaults to the app's visibility; injectable for tests. */
  visibility?: { isVisible(): boolean; subscribe(listener: () => void): () => void };
  /**
   * The session the sources read news with. Its key changes when what the
   * service answers changes: a session restored at launch, a sign-in or
   * sign-out, an upgrade. Every open query is then read again and its stories
   * replaced, so a feed read without the session is not left on screen.
   */
  session?: NewsSessionSignal;
}

export interface NewsSessionSignal {
  key(): string;
  subscribe(listener: () => void): () => void;
}

export type NewsQueryListener = (state: NewsQueryState) => void;

const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000;
/**
 * The slowest a visible app refreshes open news panes, whatever research
 * cadence is configured: headlines are the one research feed that moves by
 * the minute. A hidden app falls back to the configured cadence, which still
 * feeds breaking-news notifications.
 */
const VISIBLE_POLL_INTERVAL_MS = 2 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 15 * 1000;
const DEFAULT_INACTIVE_QUERY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_INACTIVE_QUERIES = 50;

interface SourceFetchResult {
  articles: NewsArticle[];
  sourceIds: string[];
  failedSourceIds: string[];
  errors: string[];
  nextCursor: string | null;
  access: NewsAccess | null;
  companyFrom?: CompanyFrom | null;
}

interface NewsQueryEntry {
  query: NewsQuery;
  state: NewsQueryState;
  inFlight: Promise<NewsQueryState> | null;
  /** The session generation the read in flight went out under. */
  inFlightGeneration: number;
  loadMoreInFlight: Promise<void> | null;
  loadMoreGeneration: number;
  /** The session generation the stories on screen were read under. */
  generation: number;
  refs: number;
  lastAccessedAt: number;
}

/** Held back beats live: one source the service held back is enough to say the list is not the live wire. */
function combineNewsAccess(values: ReadonlyArray<NewsAccess | null | undefined>): NewsAccess | null {
  if (values.includes("delayed")) return "delayed";
  if (values.includes("realtime")) return "realtime";
  return null;
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
  private readonly visibility: NonNullable<NewsServiceOptions["visibility"]>;
  private lastPollAt = 0;
  private unsubscribeVisibility: (() => void) | null = null;
  private readonly session?: NewsSessionSignal;
  private sessionKey: string | null = null;
  /** Bumped when the session changes; a read from an older generation is dropped. */
  private sessionGeneration = 0;
  private sessionRefetchQueued = false;
  private unsubscribeSession: (() => void) | null = null;

  constructor(options: NewsServiceOptions = {}) {
    const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollIntervalMs = typeof pollInterval === "function" ? pollInterval : () => pollInterval;
    this.inactiveQueryTtlMs = Math.max(1, options.inactiveQueryTtlMs ?? DEFAULT_INACTIVE_QUERY_TTL_MS);
    this.maxInactiveQueries = Math.max(1, Math.floor(options.maxInactiveQueries ?? DEFAULT_MAX_INACTIVE_QUERIES));
    this.now = options.now ?? Date.now;
    this.connectionHealth = options.connectionHealth;
    this.visibility = options.visibility ?? { isVisible: isAppVisible, subscribe: subscribeAppVisibility };
    this.session = options.session;
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
    // Watching a query fetches it, so the first cycle is one interval out.
    this.lastPollAt = this.now();
    // Coming back into view reschedules at the faster cadence, and polls at
    // once if a poll came due while the app was hidden.
    this.unsubscribeVisibility = this.visibility.subscribe(() => {
      if (!this.polling || this.pollInFlight) return;
      this.clearPollTimer();
      this.scheduleNextPoll();
    });
    if (this.session) {
      this.sessionKey = this.session.key();
      this.unsubscribeSession = this.session.subscribe(() => this.handleSessionChange());
    }
    this.scheduleNextPoll();
  }

  stop(): void {
    this.polling = false;
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.clearPollTimer();
  }

  /**
   * A new session answers with other news: the live wire once a Pro session
   * is in place, the held-back one after signing out. Reads still out under
   * the old session are dropped, open queries are read again and replace
   * their stories rather than merge into them, and closed ones are forgotten.
   * A token and its user arrive as separate changes, so the reads wait for
   * the end of the tick and go out once.
   */
  private handleSessionChange(): void {
    if (!this.session) return;
    const key = this.session.key();
    if (key === this.sessionKey) return;
    this.sessionKey = key;
    this.sessionGeneration++;
    if (this.sessionRefetchQueued) return;
    this.sessionRefetchQueued = true;
    queueMicrotask(() => {
      this.sessionRefetchQueued = false;
      if (!this.polling) return;
      let dropped = false;
      for (const [queryKey, entry] of this.queries) {
        if (entry.refs > 0) continue;
        this.queries.delete(queryKey);
        dropped = true;
      }
      if (dropped) {
        this.rebuildArticlePool();
        this.notify();
      }
      for (const entry of this.queries.values()) {
        void this.refreshQuery(entry.query, true);
      }
    });
  }

  private pollInFlight = false;

  private clearPollTimer(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Rescheduled every cycle so a config or visibility change takes effect on the next tick. */
  private scheduleNextPoll(): void {
    if (!this.polling) return;
    const configured = Math.max(MIN_POLL_INTERVAL_MS, this.pollIntervalMs());
    const interval = this.visibility.isVisible() ? Math.min(configured, VISIBLE_POLL_INTERVAL_MS) : configured;
    const delay = Math.max(0, this.lastPollAt + interval - this.now());
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pollInFlight = true;
      this.lastPollAt = this.now();
      void this.pollActiveQueries().catch(logFailure("news.aggregator", "Polling active news queries failed")).then(() => {
        this.pollInFlight = false;
        this.scheduleNextPoll();
      });
    }, delay);
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

  listArticles(): readonly NewsArticle[] {
    return this.articles;
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

    const generation = this.sessionGeneration;
    const request = (async () => {
      entry.state = { ...entry.state, loadingMore: true };
      this.notify();
      try {
        const result = await this.fetchFromSources({
          ...normalized,
          cursor: entry.state.nextCursor ?? undefined,
        });
        // An older page from another session must not join the list the new session read.
        if (generation !== this.sessionGeneration || entry.generation !== generation) {
          entry.state = { ...entry.state, loadingMore: false };
          this.notify();
          return;
        }
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
    entry.loadMoreGeneration = generation;
    await request;
  }

  async loadStory(storyId: string): Promise<NewsArticle | null> {
    const sources = this.enabledSources({ feed: "latest" })
      .filter((source) => !!source.provider.fetchNewsStory);

    const requestedRevisions = new Map<NewsQueryEntry, string>();
    for (const entry of this.queries.values()) {
      const article = entry.state.articles.find((article) => article.id === storyId);
      if (article) requestedRevisions.set(entry, newsArticleRevision(article));
    }
    let failed = false;
    let olderDetail: NewsArticle | null = null;
    const commitDetail = (article: NewsArticle) => {
      this.mergeStoryDetail(article, requestedRevisions);
      return this.articles.find((current) => current.id === storyId) ?? article;
    };
    for (const source of sources) {
      try {
        const article = await this.trackSourceRequest(
          source,
          "fetchNewsStory",
          () => source.provider.fetchNewsStory?.(storyId) ?? Promise.resolve(null),
        );
        if (!article) continue;
        if (article.id !== storyId) throw new Error("Story detail identity mismatch.");
        const current = this.articles.find((current) => current.id === storyId);
        if (current && article.publishedAt < current.publishedAt) {
          if (!olderDetail || article.publishedAt > olderDetail.publishedAt) olderDetail = article;
          continue;
        }
        return commitDetail(article);
      } catch (error) {
        logFailure("news.aggregator", "Loading story detail failed")(error);
        failed = true;
        // Continue to lower-priority sources.
      }
    }

    // A newer fallback is preferred. Otherwise older, explicitly dated source
    // items can enrich the timeline without rolling back the known headline.
    if (olderDetail) return commitDetail(olderDetail);
    if (failed) throw new Error("Story detail unavailable.");
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
    const generation = this.sessionGeneration;
    // A read that went out under an older session answers for that session: a new one goes out beside it.
    if (entry.inFlight && entry.inFlightGeneration === generation) return entry.inFlight;

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
        if (generation !== this.sessionGeneration) return this.currentRead(entry);
        if (result.sourceIds.length === 0 && result.failedSourceIds.length > 0) {
          throw new Error("News sources unavailable.");
        }
        if (entry.loadMoreInFlight && entry.loadMoreGeneration === generation) return entry.state;
        const incoming = filterNewsArticlesForQuery(dedupeNewsArticles(result.articles), query);
        // Stories read under another session are another feed (held back, or live): the new read replaces them.
        const sameSession = entry.generation === generation;
        // The stories a coin's fallback found are not the pair's own: once stories are filed under it, they replace them.
        const existing = !sameSession || (incoming.length > 0 && entry.state.articles.length > 0
          && (incoming[0]!.searchedFor ?? null) !== (entry.state.articles[0]!.searchedFor ?? null))
          ? []
          : entry.state.articles;
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
          error: [
            result.failedSourceIds.length > 0
              ? `${result.failedSourceIds.length} of ${result.failedSourceIds.length + result.sourceIds.length} news sources unavailable.`
              : null,
            ...result.errors,
          ].filter(Boolean).join(" ") || null,
          updatedAt: this.now(),
          sourceIds: result.sourceIds,
          nextCursor: hasOlderPages ? entry.state.nextCursor : result.nextCursor,
          loadingMore: entry.state.loadingMore,
          // A page that does not say keeps what this session's earlier answer said.
          access: result.access ?? (sameSession ? entry.state.access ?? null : null),
          companyFrom: result.companyFrom ?? null,
        };
        entry.state = state;
        entry.generation = generation;
        entry.lastAccessedAt = this.now();
        this.rebuildArticlePool();
        this.notify();
        return state;
      } catch (error) {
        if (generation !== this.sessionGeneration) return this.currentRead(entry);
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
        if (entry.inFlightGeneration === generation) entry.inFlight = null;
        this.pruneInactiveQueries();
      }
    })();

    entry.inFlight = promise;
    entry.inFlightGeneration = generation;
    return promise;
  }

  /** What a dropped read answers its caller: the current session's read when one is out, else the state as it is. */
  private currentRead(entry: NewsQueryEntry): Promise<NewsQueryState> | NewsQueryState {
    return entry.inFlight && entry.inFlightGeneration === this.sessionGeneration ? entry.inFlight : entry.state;
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
      inFlightGeneration: this.sessionGeneration,
      loadMoreInFlight: null,
      loadMoreGeneration: this.sessionGeneration,
      generation: this.sessionGeneration,
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
  ): Promise<{ articles: NewsArticle[]; nextCursor: string | null; error?: string | null; access?: NewsAccess | null; companyFrom?: CompanyFrom | null }> {
    if (source.provider.fetchNewsPage) {
      const page = await this.trackSourceRequest(
        source,
        "fetchNewsPage",
        () => source.provider.fetchNewsPage!(query),
      );
      return {
        articles: page.articles.map((article) => markDetailCapableArticle(source, article)),
        nextCursor: page.nextCursor ?? null,
        error: page.error,
        access: page.access,
        companyFrom: page.companyFrom ?? null,
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
          errors: page.error ? [page.error] : [],
          nextCursor: page.nextCursor,
          access: page.access ?? null,
          companyFrom: page.companyFrom ?? null,
        };
        if (page.articles.length > 0) return result;
        firstEmpty ??= result;
      } catch {
        failedSourceIds.push(newsCapabilitySourceId(source));
      }
    }
    return firstEmpty ?? { articles: [], sourceIds: [], failedSourceIds, errors: [], nextCursor: null, access: null };
  }

  private async fetchMergedNews(query: NewsQuery, sources: NewsCapability[]): Promise<SourceFetchResult> {
    const settled = await Promise.allSettled(
      sources.map(async (source) => ({
        source,
        page: await this.readSourcePage(source, query),
      })),
    );
    const articles: NewsArticle[] = [];
    const errors: string[] = [];
    const sourceIds: string[] = [];
    const failedSourceIds: string[] = [];
    const access: Array<NewsAccess | null | undefined> = [];
    let nextCursor: string | null = null;
    settled.forEach((result, index) => {
      if (result.status !== "fulfilled") {
        const source = sources[index];
        if (source) failedSourceIds.push(newsCapabilitySourceId(source));
        return;
      }
      articles.push(...result.value.page.articles);
      if (result.value.page.error) errors.push(result.value.page.error);
      sourceIds.push(newsCapabilitySourceId(result.value.source));
      access.push(result.value.page.access);
      nextCursor ??= result.value.page.nextCursor;
    });
    return { articles, sourceIds, failedSourceIds, errors, nextCursor, access: combineNewsAccess(access) };
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
        access: entry.state.access ?? null,
        companyFrom: entry.state.companyFrom ?? null,
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

  private mergeStoryDetail(article: NewsArticle, requestedRevisions: Map<NewsQueryEntry, string>): void {
    let changed = false;
    for (const entry of this.queries.values()) {
      let stateChanged = false;
      const nextArticles = entry.state.articles.map((existing) => {
        if (existing.id !== article.id || requestedRevisions.get(entry) !== newsArticleRevision(existing)) return existing;
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
}
