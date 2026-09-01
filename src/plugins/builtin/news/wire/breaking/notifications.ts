import type { GloomPluginContext } from "../../../../../types/plugin";
import type { MarketNewsItem, NewsQueryState } from "../../../../../types/news-source";
import { NEWS_QUERY_PRESETS } from "../news/query-presets";
import {
  BREAKING_NEWS_MUTED_SECTORS_KEY,
  BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY,
  BREAKING_NEWS_SCOPE_KEY,
  parseBreakingScope,
  parseMutedSectors,
  selectNotifiableArticles,
} from "./filters";

export { BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY };

const MAX_SEEN_ARTICLE_IDS = 500;
/** Long enough to read a stacked burst, short enough to clear itself. */
const BREAKING_TOAST_DURATION_MS = 20_000;
const SNOOZE_DURATION_MS = 60 * 60_000;
const SNOOZE_STATE_KEY = "breaking-news-snooze-until";

function isReadyState(state: NewsQueryState): boolean {
  return state.phase === "ready" || state.phase === "refreshing";
}

function rememberArticleIds(current: Set<string>, articles: MarketNewsItem[]): Set<string> {
  const next: string[] = [];
  const included = new Set<string>();

  for (const article of articles) {
    if (included.has(article.id)) continue;
    included.add(article.id);
    next.push(article.id);
  }

  for (const id of current) {
    if (included.has(id)) continue;
    included.add(id);
    next.push(id);
    if (next.length >= MAX_SEEN_ARTICLE_IDS) break;
  }

  return new Set(next.slice(0, MAX_SEEN_ARTICLE_IDS));
}

function notificationSubtitle(article: MarketNewsItem): string {
  const tickers = article.tickers.slice(0, 3).join(" ");
  return tickers ? `${article.source} ${tickers}` : article.source;
}

export function setupBreakingNewsNotifications(ctx: GloomPluginContext): () => void {
  let disposeWatch: (() => void) | null = null;
  let primed = false;
  let seenArticleIds = new Set<string>();
  let watchedSymbols = new Set<string>();

  const enabled = () => ctx.configState.get<boolean>(BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY) === true;

  // Snooze is intentionally local: it is short-lived and must not race the
  // cloud sync snapshot across devices.
  const snoozedUntil = () => ctx.persistence.getState<number>(SNOOZE_STATE_KEY) ?? 0;
  const isSnoozed = () => snoozedUntil() > Date.now();
  const snooze = () => {
    ctx.persistence.setState(SNOOZE_STATE_KEY, Date.now() + SNOOZE_DURATION_MS);
    ctx.notify({
      body: "Breaking news snoozed for 1 hour.",
      type: "info",
      desktop: "never",
    });
  };

  const refreshWatchedSymbols = async () => {
    try {
      const tickers = await ctx.tickerRepository.loadAllTickers();
      const next = new Set<string>();
      for (const ticker of tickers) {
        const metadata = ticker.metadata;
        const tracked =
          (metadata.watchlists?.length ?? 0) > 0 ||
          (metadata.portfolios?.length ?? 0) > 0 ||
          (metadata.positions?.length ?? 0) > 0;
        if (tracked) next.add(metadata.ticker.toUpperCase());
      }
      watchedSymbols = next;
    } catch (error) {
      ctx.log.warn(`breaking notifications could not load watched tickers: ${error}`);
    }
  };

  const notifyNewBreakingArticles = (articles: MarketNewsItem[]): void => {
    const latest = [...articles].sort(
      (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
    )[0];
    if (!latest) return;

    const extraCount = articles.length - 1;
    ctx.notify({
      title: "Breaking News",
      subtitle: notificationSubtitle(latest),
      body: extraCount > 0 ? `${latest.title} (+${extraCount} more)` : latest.title,
      type: "info",
      desktop: "always",
      duration: BREAKING_TOAST_DURATION_MS,
      action: {
        label: "Open",
        onClick: () => ctx.showPane("news-breaking"),
      },
      secondaryAction: {
        label: "Snooze 1h",
        onClick: snooze,
      },
    });
  };

  const handleState = (state: NewsQueryState) => {
    if (!isReadyState(state)) return;

    if (!primed) {
      seenArticleIds = rememberArticleIds(seenArticleIds, state.articles);
      primed = true;
      return;
    }

    const freshArticles = state.articles.filter((article) => !seenArticleIds.has(article.id));
    // Mark everything seen regardless of filtering, so relaxing a filter later
    // does not replay a backlog of old stories as if they just broke.
    seenArticleIds = rememberArticleIds(seenArticleIds, state.articles);
    if (freshArticles.length === 0) return;
    if (!enabled() || isSnoozed()) return;

    const notifiable = selectNotifiableArticles(freshArticles, {
      scope: parseBreakingScope(ctx.configState.get(BREAKING_NEWS_SCOPE_KEY)),
      mutedSectors: parseMutedSectors(ctx.configState.get(BREAKING_NEWS_MUTED_SECTORS_KEY)),
      watchedSymbols,
    });
    if (notifiable.length === 0) return;

    notifyNewBreakingArticles(notifiable);
  };

  const stop = () => {
    disposeWatch?.();
    disposeWatch = null;
    primed = false;
    seenArticleIds = new Set();
  };

  const start = () => {
    if (disposeWatch) return;
    if (!ctx.watchNewsQuery) {
      ctx.log.warn("breaking notifications unavailable: news query watcher missing");
      return;
    }
    void refreshWatchedSymbols();
    disposeWatch = ctx.watchNewsQuery(NEWS_QUERY_PRESETS.breaking, handleState);
  };

  const sync = () => {
    if (enabled()) start();
    else stop();
  };

  const disposeConfigListener = ctx.on("config:changed", () => {
    void refreshWatchedSymbols();
    sync();
  });
  const disposeTickerAdded = ctx.on("ticker:added", () => void refreshWatchedSymbols());
  const disposeTickerRemoved = ctx.on("ticker:removed", () => void refreshWatchedSymbols());
  sync();

  return () => {
    disposeConfigListener();
    disposeTickerAdded();
    disposeTickerRemoved();
    stop();
  };
}
