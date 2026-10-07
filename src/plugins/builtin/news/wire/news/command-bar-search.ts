import { apiClient } from "../../../../../api-client";
import { getSharedNewsService } from "../../../../../news/hooks";
import type { NewsService } from "../../../../../news/aggregator";
import type { NewsArticle } from "../../../../../news/types";
import type {
  CommandBarResultDef,
  CommandBarSearchProvider,
  GloomPluginContext,
} from "../../../../../types/plugin";
import { formatFeedTime } from "../../../../../utils/datetime-format";
import { openNewsStoryPane } from "./pop-out";
import { NEWS_QUERY_PRESETS } from "./query-presets";

/** The corpus News section shows four as well, and each costs a row of the sheet. */
const STORY_ROW_LIMIT = 4;

/** A word keeps inner hyphens and dots, so "10-K" and "U.S." stay one word. */
const WORD = /[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)*/gu;

function queryTokens(query: string): string[] {
  // One-letter words would match nearly every story by prefix.
  return (query.toLowerCase().match(WORD) ?? []).filter((token) => token.length >= 2);
}

/** Each word, and the parts of a hyphenated one, so "driven" still finds "AI-driven". */
function storyWords(article: NewsArticle): string[] {
  const words = `${article.title} ${article.summary ?? ""} ${article.source}`.toLowerCase().match(WORD) ?? [];
  return words.flatMap((word) => (/[-.]/.test(word) ? [word, ...word.split(/[-.]/)] : [word]));
}

/**
 * Loaded stories whose headline, summary, source or tickers have a word that
 * starts with every word of the query, newest first. Prefixes rather than
 * substrings, so "hor" finds Hormuz but not every "author" and "shortage".
 */
export function matchLoadedStories(
  articles: readonly NewsArticle[],
  query: string,
  limit = STORY_ROW_LIMIT,
): NewsArticle[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  return articles
    .filter((article) => {
      const words = storyWords(article);
      const tickers = article.tickers.map((ticker) => ticker.toLowerCase());
      return tokens.every((token) => (
        tickers.some((ticker) => ticker.startsWith(token))
        || words.some((word) => word.startsWith(token))
      ));
    })
    .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime())
    .slice(0, limit);
}

interface StorySearchDeps {
  getService(): NewsService | null;
  isSignedIn(): boolean;
  now(): number;
}

const defaultDeps: StorySearchDeps = {
  getService: getSharedNewsService,
  isSignedIn: () => apiClient.isSignedIn(),
  now: Date.now,
};

let warming: Promise<unknown> | null = null;

/**
 * Unless News Feed is open, the app may hold few stories or none, so a lookup
 * first loads the latest feed News Feed reads (the same request, delayed when
 * the account has no live news). The service keeps it for a while after, so
 * later lookups reuse it instead of asking again.
 */
async function warmLatestStories(service: NewsService): Promise<void> {
  if (service.getQueryState(NEWS_QUERY_PRESETS.feed).articles.length > 0) return;
  warming ??= service.load(NEWS_QUERY_PRESETS.feed).catch(() => null).finally(() => {
    warming = null;
  });
  await warming;
}

/**
 * Stories the app has already loaded, for a signed-out command bar. Signed in,
 * the News section comes from the Gloom Cloud corpus search instead, which
 * covers these stories and much more, so this stays quiet rather than listing
 * the same story twice.
 */
export function createLoadedStorySearchProvider(
  ctx: Pick<GloomPluginContext, "createPaneFromTemplate">,
  deps: StorySearchDeps = defaultDeps,
): CommandBarSearchProvider {
  return {
    id: "news:loaded-stories",
    category: "News",
    priority: 190,
    minQueryLength: 3,
    debounceMs: 150,
    async provide(query, _context, signal): Promise<CommandBarResultDef[]> {
      if (deps.isSignedIn()) return [];
      const service = deps.getService();
      if (!service) return [];
      await warmLatestStories(service);
      if (signal.aborted) return [];
      const now = deps.now();
      return matchLoadedStories(service.listArticles(), query).map((article) => ({
        id: article.id,
        label: article.title,
        detail: article.source,
        right: formatFeedTime(article.publishedAt, now),
        keywords: article.tickers,
        execute: () => openNewsStoryPane(article, ctx.createPaneFromTemplate),
      }));
    },
  };
}
