import type { CompanyFrom } from "../types/company-from";

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

/**
 * A Form 4 a story about insiders trading reports: one filing's lines of the
 * side the story reports, by an insider it names, dated in the period it names,
 * summed as filed.
 */
export interface NewsInsiderFiling {
  accession: string;
  form: string;
  /** YYYY-MM-DD. */
  filedOn: string;
  issuerName: string | null;
  ticker: string | null;
  /** The reporting owner as filed: "STEVENS MARK A". */
  insider: string;
  title: string | null;
  side: "sale" | "purchase";
  firstTradeDate: string;
  lastTradeDate: string;
  lines: number;
  shares: number;
  value: number;
  weightedPrice: number;
  rule10b51: boolean | null;
  url: string;
}

/**
 * A story's times as the service reports them, ISO instants: its first and
 * latest publication across the reports it gathers, and when the service first
 * and last saw it. A field the service did not send is absent.
 */
export interface NewsStoryTimes {
  firstPublishedAt?: string;
  lastPublishedAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface NewsArticle {
  id: string;
  title: string;
  url: string;
  source: string;
  /** When the story was first published, the earliest time known for it: what lists show and sort by. */
  publishedAt: Date;
  /** Every time the service reported for the story (a later report's publication, when it was seen), kept as sent. */
  times?: NewsStoryTimes;
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
  /** The routine notices the story stands for in a company's feed (a buy-back's daily notices), its own included. */
  routine?: NewsRoutineNotices;
  /** A story about insiders trading: the Form 4s it reports, as Gloom Cloud matched them. */
  insiderFilings?: NewsInsiderFiling[];
  /**
   * The text this story was found by, when it stands in for a coin pair's feed
   * no story is filed under: the stories that mention "bitcoin" for BTC-USD.
   */
  searchedFor?: string;

  // Compatibility aliases for RSS/ticker-news panes and existing table columns.
  importance: number;
}

interface NewsRoutineNotices {
  kind: string;
  notices: number;
  since: Date;
  programme: string | null;
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

/**
 * Which news a source answered with: the live wire, or the one held back for
 * an account without real-time news. Read from the answer itself, never from
 * the plan the app remembers.
 */
export type NewsAccess = "realtime" | "delayed";

export interface NewsPage {
  /** Active source failure, including a partial failure with usable articles. */
  error?: string | null;
  articles: NewsArticle[];
  nextCursor?: string | null;
  /** Which news the source answered with; null or absent when the answer does not say. */
  access?: NewsAccess | null;
  /** The company's home line the stories are read from, when not the listing asked (a receipt, a foreign line). */
  companyFrom?: CompanyFrom | null;
}

export interface NewsQueryState {
  phase: NewsQueryPhase;
  articles: NewsArticle[];
  error: string | null;
  updatedAt: number | null;
  savedAt?: number;
  sourceIds: string[];
  nextCursor: string | null;
  loadingMore: boolean;
  /** Which news the stories are, from the last answer; null or absent when it did not say. */
  access?: NewsAccess | null;
  /** The company's home line the stories are read from, when not the listing asked. */
  companyFrom?: CompanyFrom | null;
}
