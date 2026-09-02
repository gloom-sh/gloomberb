import type { MarketNewsItem } from "../../../../../types/news-source";
import { SECTOR_NEWS_SECTORS, sectorNewsLabel } from "../news/query-presets";

export const BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY = "breakingNewsNotificationsEnabled";
export const BREAKING_NEWS_SCOPE_KEY = "breakingNewsScope";
export const BREAKING_NEWS_MUTED_SECTORS_KEY = "breakingNewsMutedSectors";

export const BREAKING_SCOPES = [
  "watchlist-macro",
  "watchlist",
  "macro",
  "all",
] as const;

export type BreakingScope = (typeof BREAKING_SCOPES)[number];

export const DEFAULT_BREAKING_SCOPE: BreakingScope = "watchlist-macro";

export const BREAKING_SCOPE_OPTIONS = [
  {
    value: "watchlist-macro",
    label: "Watchlist + macro",
    description: "Stories about tickers you track, plus market-wide events.",
  },
  {
    value: "watchlist",
    label: "Watchlist only",
    description: "Only stories linked to a ticker you watch or hold.",
  },
  {
    value: "macro",
    label: "Macro only",
    description: "Only market-wide events with no single ticker.",
  },
  { value: "all", label: "Everything", description: "Every breaking story." },
];

export const BREAKING_MUTED_SECTOR_OPTIONS = SECTOR_NEWS_SECTORS.map((sector) => ({
  value: sector,
  label: sectorNewsLabel(sector),
}));

export function parseBreakingScope(value: unknown): BreakingScope {
  return BREAKING_SCOPES.includes(value as BreakingScope)
    ? (value as BreakingScope)
    : DEFAULT_BREAKING_SCOPE;
}

export function parseMutedSectors(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
}

/**
 * A story with no ticker links is market-wide: policy, geopolitics, or market
 * structure. The server never attributes those to a symbol, so absence of
 * tickers is the signal.
 */
export function isMacroArticle(article: MarketNewsItem): boolean {
  return article.tickers.length === 0;
}

export function matchesWatchlist(
  article: MarketNewsItem,
  watchedSymbols: ReadonlySet<string>,
): boolean {
  return article.tickers.some((ticker) => watchedSymbols.has(ticker.toUpperCase()));
}

export function matchesScope(
  article: MarketNewsItem,
  scope: BreakingScope,
  watchedSymbols: ReadonlySet<string>,
): boolean {
  if (scope === "all") return true;
  if (scope === "macro") return isMacroArticle(article);
  if (scope === "watchlist") return matchesWatchlist(article, watchedSymbols);
  return isMacroArticle(article) || matchesWatchlist(article, watchedSymbols);
}

/**
 * Muted only when every sector is muted. A story spanning a muted and an
 * unmuted sector still matters, so partial overlap is deliberately kept.
 */
export function isSectorMuted(
  article: MarketNewsItem,
  mutedSectors: ReadonlySet<string>,
): boolean {
  if (mutedSectors.size === 0 || article.sectors.length === 0) return false;
  return article.sectors.every((sector) => mutedSectors.has(sector));
}

export interface BreakingNotificationFilter {
  scope: BreakingScope;
  mutedSectors: ReadonlySet<string>;
  watchedSymbols: ReadonlySet<string>;
}

export function selectNotifiableArticles(
  articles: MarketNewsItem[],
  filter: BreakingNotificationFilter,
): MarketNewsItem[] {
  return articles.filter(
    (article) =>
      matchesScope(article, filter.scope, filter.watchedSymbols) &&
      !isSectorMuted(article, filter.mutedSectors),
  );
}
