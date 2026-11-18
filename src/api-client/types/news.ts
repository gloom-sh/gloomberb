import type { CompanyFrom } from "../../types/company-from";

interface CloudNewsEntityPayload {
  id: string;
  entityType: string;
  name: string;
  symbol: string | null;
  exchange: string | null;
  canonicalTicker: string | null;
  role: string | null;
  confidence: number | null;
}

interface CloudNewsTickerLinkPayload {
  symbol: string;
  exchange: string;
  canonicalTicker: string;
  relationType: string;
  displayTier: "primary" | "related";
  confidence: number;
  relevanceScore: number;
  impactScore?: number;
  /** The company's market cap, stated on its home listing and not on a cross-listing. */
  marketCap?: number | null;
  sentiment?: "positive" | "neutral" | "negative" | null;
}

export interface CloudNewsStoryItemPayload {
  id: string;
  sourceKey: string;
  sourceName: string;
  title: string;
  summary?: string;
  url: string;
  publishedAt: string;
  hasArticleText?: boolean;
}

/**
 * A Form 4 a story about insiders trading reports, as Gloom Cloud matched it:
 * the filing's lines of the side the story reports, by an insider it names,
 * dated in the period it names, summed.
 */
export interface CloudStoryInsiderFilingPayload {
  accession: string;
  form: string;
  /** YYYY-MM-DD. */
  filedOn: string;
  issuerCik: string;
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
  /** value / shares: the share-weighted average of the lines' prices. */
  weightedPrice: number;
  /** Under a Rule 10b5-1 plan: true, false, or null when the stored filing does not say. */
  rule10b51: boolean | null;
  /** The filing's index page on SEC EDGAR. */
  url: string;
}

/** A story that reports a Form 4, as the filing's row names it. */
export interface CloudInsiderFilingStoryPayload {
  id: string;
  headline: string;
  firstPublishedAt: string;
  lastPublishedAt: string;
  primaryPublisher: string;
}

export interface CloudInsiderFilingStoriesResponse {
  items: Array<{ accession: string; stories: CloudInsiderFilingStoryPayload[] }>;
}

export interface CloudNewsPayload {
  id: string;
  headline: string;
  summary: string;
  topic?: string;
  topics?: string[];
  category: string;
  sentiment: "positive" | "neutral" | "negative";
  sectors: string[];
  scope?: string;
  firstPublishedAt: string;
  lastPublishedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  primaryUrl: string;
  /** Routing key of the representative item, for source filters. */
  primarySource: string;
  /** Who published the representative item (FT, SEC, @unusual_whales). */
  primaryPublisher?: string;
  publishers?: string[];
  scores?: {
    importance?: number;
    urgency?: number;
    marketImpact?: number;
    novelty?: number;
    confidence?: number;
  };
  flags?: {
    breaking?: boolean;
    developing?: boolean;
    stale?: boolean;
  };
  variantCount: number;
  sourceCount: number;
  sources: string[];
  entities: CloudNewsEntityPayload[];
  tickerLinks: CloudNewsTickerLinkPayload[];
  items?: CloudNewsStoryItemPayload[];
  /** A story about insiders trading: the Form 4s it reports. Absent from other stories and older servers. */
  insiderFilings?: CloudStoryInsiderFilingPayload[];
  /**
   * The routine notices this story stands for in a company's feed, its own first: a buy-back's daily
   * "Transaction in own shares", the monthly total voting rights. Absent from servers that list each one.
   */
  routine?: CloudNewsRoutinePayload;
}

export interface CloudNewsRoutinePayload {
  kind: string;
  /** How many notices the row stands for, its own included. */
  notices: number;
  /** The first notice's publication time. */
  since: string;
  /** "buy-back announced on 2026-10-28", when the notices name it. */
  programme?: string | null;
  storyIds?: string[];
}

export interface CloudNewsListResponse {
  items: CloudNewsPayload[];
  nextCursor: string | null;
  /** Which news the service answered with, when it says: the live wire, or the one held back for a free account. */
  access?: "realtime" | "delayed";
  /**
   * A search asked for its closest stories: `all` when stories have every
   * word, `closest` when none does and these have the most of them.
   */
  match?: "all" | "closest";
  /** A receipt's or foreign line's feed is its company's: the home line it reads, when not the listing asked. */
  companyFrom?: CompanyFrom;
}
