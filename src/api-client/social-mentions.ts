export type SocialMentionsRange = "1y" | "5y" | "max";

interface SocialMentionDay {
  /** UTC day. */
  day: string;
  mentions: number;
  /** False while the day is still being counted. */
  closed: boolean;
}

export interface SocialMentionPost {
  id: string;
  day: string;
  author: string;
  text: string;
  postedAt: string;
  /** Null before X showed view counts (2022-12-22). */
  views: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  url: string;
  /** Jev bullish minus bearish probability, -1..1. */
  stance: number | null;
}

export interface SocialMentionsPayload {
  symbol: string;
  range: SocialMentionsRange;
  asOf: string;
  x: {
    days: SocialMentionDay[];
    historyFrom: string | null;
    completeThrough: string | null;
    /** Median posts per closed day over the last 30. */
    baseline: number | null;
    refreshedAt: string | null;
  };
  /** View-weighted stance of each day's top posts. */
  stance: Array<{ day: string; score: number; posts: number }>;
  topPosts: SocialMentionPost[];
  /** Daily user views of the company's English Wikipedia article; absent on older servers. */
  wikipedia?: {
    article: string | null;
    days: Array<{ day: string; views: number }>;
    /** Median views over the 30 days ending at the last stored day. */
    baseline: number | null;
  };
  /** Posts and comments naming the ticker in finance subreddits, per finished UTC day; absent on older servers. */
  reddit?: {
    days: Array<{ day: string; mentions: number }>;
    baseline: number | null;
  };
  /** Parts still filling on the server; ask again shortly. */
  pending: Array<"history" | "posts">;
  warnings: string[];
}

export interface SocialMentionDayPosts {
  symbol: string;
  day: string;
  posts: SocialMentionPost[];
}

/** Each ticker's latest closed day, or today's count so far. */
export type SocialOutlierWindow = "day" | "today";
/** Market value bands in US dollars: micro under $300M, small to $2B, mid to $10B, large above. */
export type SocialOutlierCap = "micro" | "small" | "mid" | "large";

export interface CloudSocialOutliersParams {
  window?: SocialOutlierWindow;
  /** Least posts on the day counted. */
  minPosts?: number;
  cap?: SocialOutlierCap;
  limit?: number;
}

/** A ticker's posts on X on one UTC day against its own 30-day median. */
export interface SocialOutlierRow {
  symbol: string;
  name: string | null;
  /** UTC day counted. */
  day: string;
  mentions: number;
  /** False for today's count so far. */
  closed: boolean;
  /** When the day's count was read. */
  countedAt: string;
  /** Median posts per closed day over the 30 days ending at the ticker's latest closed day. */
  baseline: number;
  /** Posts over the median, the median floored at one post a day. */
  ratio: number;
  /** View-weighted stance of the day's scored top posts, -1..1. */
  stance: number | null;
  stancePosts: number;
  marketCap: number | null;
  /** The latest session's move, with its date, when it is recent. */
  price: { changePct: number; asOf: string } | null;
}

export interface SocialOutliersPayload {
  window: SocialOutlierWindow;
  asOf: string;
  /** Tickers last counted before this closed day are stale and left out. */
  freshFrom: string;
  filters: { minPosts: number; cap: SocialOutlierCap | null };
  /** Tickers with a 30-day median, and those of them with a fresh count in the window. */
  coverage: { tracked: number; counted: number };
  rows: SocialOutlierRow[];
}
