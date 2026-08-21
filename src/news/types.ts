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
  items?: NewsStoryItem[];

  // Compatibility aliases for RSS/Yahoo panes and existing table columns.
  importance: number;
}

export interface NewsQuery {
  feed?: NewsFeed;
  scope?: NewsQueryScope;
  ticker?: string;
  exchange?: string;
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

export type NewsQueryPhase = "idle" | "loading" | "ready" | "refreshing" | "error";

export interface NewsPage {
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
