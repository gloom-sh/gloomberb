type NewsQueryScope = "global" | "ticker";
export type NewsFeed = "latest" | "top" | "breaking" | "ticker" | "sector" | "topic";
type NewsSentiment = "positive" | "neutral" | "negative";

interface NewsScores {
  importance: number;
  urgency: number;
  marketImpact: number;
  novelty: number;
  confidence: number;
}

export interface NewsStoryItem {
  id: string;
  sourceKey: string;
  sourceName: string;
  title: string;
  summary?: string;
  url: string;
  publishedAt: Date;
  hasArticleText?: boolean;
}

export interface NewsArticle {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: Date;
  summary?: string;
  imageUrl?: string;
  topic: string;
  topics: string[];
  sectors: string[];
  categories: string[];
  tickers: string[];
  sentiment?: NewsSentiment;
  scores: NewsScores;
  isBreaking: boolean;
  isDeveloping: boolean;
  sourceCount?: number;
  items?: NewsStoryItem[];
  /**
   * The text this story was found by, when it stands in for a coin pair's feed
   * no story is filed under: the stories that mention "bitcoin" for BTC-USD.
   */
  searchedFor?: string;

  // Compatibility aliases for RSS/ticker-news panes and existing table columns.
  importance: number;
}

export interface NewsQuery {
  feed?: NewsFeed;
  /** @deprecated Set `feed: "ticker"` instead. */
  scope?: NewsQueryScope;
  ticker?: string;
  exchange?: string;
  /**
   * The listing's name, which a coin pair's feed searches stories for when none
   * are filed under the pair ("Hyperliquid USD" for HYPE32196-USD). Not part of
   * the query's key: it is the same listing's name.
   */
  listingName?: string;
  tickerTier?: "primary" | "related" | "any";
  tickerRelations?: string[];
  topics?: string[];
  sectors?: string[];
  sources?: string[];
  excludeSources?: string[];
  sentiment?: NewsSentiment;
  minImportance?: number;
  minUrgency?: number;
  breaking?: boolean;
  limit?: number;
  categories?: string[];
  since?: Date;
  until?: Date;
  cursor?: string;
}

type NewsQueryPhase = "idle" | "loading" | "ready" | "refreshing" | "error";

export interface NewsPage {
  /** Active source failure, including a partial failure with usable articles. */
  error?: string | null;
  articles: NewsArticle[];
  nextCursor?: string | null;
}

export interface NewsQueryState {
  phase: NewsQueryPhase;
  articles: NewsArticle[];
  error: string | null;
  updatedAt: number | null;
  sourceIds: string[];
  nextCursor: string | null;
  loadingMore: boolean;
}
