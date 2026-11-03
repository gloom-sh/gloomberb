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
