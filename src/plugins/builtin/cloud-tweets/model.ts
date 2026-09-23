import type { DataTableColumn } from "../../../components";
import type {
  CloudTweetPayload,
  CloudTweetQueryType,
  CloudTweetSearchResponse,
} from "../../../api-client";
import { formatCompact, formatTimeAgo } from "../../../utils/format";
import { normalizeTweetText } from "../../../utils/tweet-text";
import { truncateWithEllipsis } from "../../../utils/text-wrap";
import { toTimestampMillis } from "../../../utils/timestamp";
import { collectUniqueTickerSymbols } from "../../../tickers/tokenizer";
import { normalizedHttpUrl } from "../../../utils/url";

export const DEFAULT_TWEET_HOURS = 6;
export const DEFAULT_TWEET_LIMIT = 50;
export const TWEET_SEARCH_SCHEMA_VERSION = 1;
export const TWEET_SEARCH_DEBOUNCE_MS = 450;
export const TWITTER_FEED_PANE_ID = "twitter-feed";
export const TWITTER_FEED_LAUNCH_STATE_KEY = "twitter-feed-launch";
export const TWITTER_FEED_LAUNCH_SCHEMA_VERSION = 1;

const TWITTER_USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

type TweetColumnId = "time" | "author" | "text" | "tickers" | "likes" | "views";
export type TweetColumn = DataTableColumn & { id: TweetColumnId };
export type TweetSortColumnId = "time" | "likes" | "views";
export type TweetSortDirection = "asc" | "desc";

export interface TweetLoadState {
  /** The pages loaded so far, merged into one response. */
  data: CloudTweetSearchResponse | null;
  loading: boolean;
  error: string | null;
  loadingMore: boolean;
  hasMore: boolean;
}

/** Pages overlap when tweets arrive while a feed is being read. */
export function appendNewTweets(
  current: CloudTweetPayload[],
  incoming: CloudTweetPayload[],
): CloudTweetPayload[] {
  const known = new Set(current.map((tweet) => tweet.id));
  const added = incoming.filter((tweet) => !known.has(tweet.id));
  return added.length > 0 ? [...current, ...added] : current;
}

/**
 * A background refresh of the first page: its tweets replace their older
 * copies (views and replies move) and new ones join, while the older pages
 * the reader already loaded stay.
 */
export function mergeLatestTweets(
  current: CloudTweetPayload[],
  latest: CloudTweetPayload[],
): CloudTweetPayload[] {
  if (latest.length === 0) return current;
  const latestIds = new Set(latest.map((tweet) => tweet.id));
  return [...latest, ...current.filter((tweet) => !latestIds.has(tweet.id))];
}

export interface TwitterFeed {
  id: string;
  title: string;
  query: string;
  queryType: CloudTweetQueryType;
  createdAt: number;
  updatedAt: number;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export interface PersistedTwitterFeedState {
  feeds: TwitterFeed[];
}

export interface TwitterFeedLaunchRequest {
  query: string;
  targetPaneId: string | null;
  nonce: string;
  createdAt: number;
  queryType?: CloudTweetQueryType;
}

export const EMPTY_FEED_STATE: PersistedTwitterFeedState = { feeds: [] };

let nextTwitterFeedId = 1;

function generateFeedId(): string {
  return `${Date.now()}-${nextTwitterFeedId++}`;
}

export function deriveFeedTitle(query: string): string {
  const tickers = collectUniqueTickerSymbols([query]);
  if (tickers.length > 0) return tickers.slice(0, 3).map((ticker) => `$${ticker}`).join(" ");
  return truncateWithEllipsis(query.replace(/\s+/g, " ").trim(), 24) || "New";
}

export function createFeed(query: string, queryType: CloudTweetQueryType): TwitterFeed {
  const now = Date.now();
  return {
    id: generateFeedId(),
    title: deriveFeedTitle(query),
    query,
    queryType,
    createdAt: now,
    updatedAt: now,
    lastSuccessAt: null,
    lastError: null,
  };
}

export function normalizeFeedQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeTwitterUsername(username: string): string | null {
  const normalized = username.trim().replace(/^@/, "");
  return TWITTER_USERNAME_RE.test(normalized) ? normalized : null;
}

export function twitterUserSearchQuery(username: string): string {
  return `from:${username}`;
}

export function normalizeFeeds(value: unknown): TwitterFeed[] {
  const entries = Array.isArray((value as PersistedTwitterFeedState | undefined)?.feeds)
    ? (value as PersistedTwitterFeedState).feeds
    : [];
  return entries
    .filter((entry): entry is TwitterFeed => (
      !!entry
      && typeof entry === "object"
      && typeof entry.id === "string"
      && typeof entry.query === "string"
    ))
    .map((entry) => ({
      ...entry,
      title: typeof entry.title === "string" && entry.title.trim() ? entry.title : deriveFeedTitle(entry.query),
      queryType: entry.queryType === "Top" ? "Top" : "Latest",
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
      lastSuccessAt: typeof entry.lastSuccessAt === "number" ? entry.lastSuccessAt : null,
      lastError: typeof entry.lastError === "string" ? entry.lastError : null,
    }));
}

export function formatRelativeShort(value: string): string {
  return formatTimeAgo(value).replace(" ago", "").replace("just now", "<1m");
}

export function formatMetric(value: number | null | undefined): string {
  if (value == null) return "-";
  if (Math.abs(value) >= 1000) return formatCompact(value);
  return String(value);
}

export function normalizeTweetDisplayText(value: string): string {
  return normalizeTweetText(value, { preserveLineBreaks: true });
}

export function normalizeTweetCellText(value: string): string {
  return normalizeTweetText(value);
}

export function tweetTickers(tweet: CloudTweetPayload): string[] {
  return collectUniqueTickerSymbols([normalizeTweetDisplayText(tweet.text)]);
}

function tweetCreatedAtMs(tweet: CloudTweetPayload): number {
  const ms = toTimestampMillis(tweet.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

function compareNullableNumber(
  left: number | null | undefined,
  right: number | null | undefined,
  sortDirection: TweetSortDirection,
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  const comparison = left - right;
  return sortDirection === "asc" ? comparison : -comparison;
}

export function isTweetSortColumnId(columnId: string): columnId is TweetSortColumnId {
  return columnId === "time" || columnId === "likes" || columnId === "views";
}

function compareTweets(
  left: CloudTweetPayload,
  right: CloudTweetPayload,
  sortColumnId: TweetSortColumnId,
  sortDirection: TweetSortDirection,
): number {
  let comparison = 0;
  switch (sortColumnId) {
    case "time":
      comparison = tweetCreatedAtMs(left) - tweetCreatedAtMs(right);
      if (comparison !== 0) {
        return sortDirection === "asc" ? comparison : -comparison;
      }
      break;
    case "likes":
      comparison = compareNullableNumber(left.metrics.likes, right.metrics.likes, sortDirection);
      break;
    case "views":
      comparison = compareNullableNumber(left.metrics.views, right.metrics.views, sortDirection);
      break;
  }

  if (comparison !== 0) return comparison;

  return tweetCreatedAtMs(right) - tweetCreatedAtMs(left);
}

export function sortedTweets(
  tweets: CloudTweetPayload[],
  sortColumnId: TweetSortColumnId,
  sortDirection: TweetSortDirection,
): CloudTweetPayload[] {
  return [...tweets].sort((left, right) => compareTweets(left, right, sortColumnId, sortDirection));
}

function mediaImageUrl(value: unknown): string | null {
  const directUrl = normalizedHttpUrl(value);
  if (directUrl) return directUrl;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  return normalizedHttpUrl(record.mediaUrl)
    ?? normalizedHttpUrl(record.media_url_https)
    ?? normalizedHttpUrl(record.media_url)
    ?? normalizedHttpUrl(record.previewImageUrl)
    ?? normalizedHttpUrl(record.preview_image_url)
    ?? normalizedHttpUrl(record.url);
}

function nestedMedia(record: Record<string, unknown>, key: string): unknown {
  const value = record[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>).media : undefined;
}

export function tweetImageUrls(tweet: CloudTweetPayload): string[] {
  const record = tweet as unknown as Record<string, unknown>;
  const candidates = [
    record.media,
    record.photos,
    record.images,
    nestedMedia(record, "entities"),
    nestedMedia(record, "extendedEntities"),
    nestedMedia(record, "extended_entities"),
  ];
  const urls = new Set<string>();
  for (const candidate of candidates) {
    const entries = Array.isArray(candidate) ? candidate : candidate == null ? [] : [candidate];
    for (const entry of entries) {
      const url = mediaImageUrl(entry);
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

export function buildTweetColumns(width: number): TweetColumn[] {
  const timeWidth = 7;
  const authorWidth = 16;
  const tickersWidth = 24;
  const likesWidth = 7;
  const viewsWidth = 8;
  const textWidth = Math.max(
    20,
    width - timeWidth - authorWidth - tickersWidth - likesWidth - viewsWidth - 9,
  );
  return [
    { id: "time", label: "TIME", width: timeWidth, align: "left" },
    { id: "author", label: "AUTHOR", width: authorWidth, align: "left" },
    { id: "text", label: "TWEET", width: textWidth, align: "left" },
    { id: "tickers", label: "TICKERS", width: tickersWidth, align: "left" },
    { id: "likes", label: "LIKES", width: likesWidth, align: "right" },
    { id: "views", label: "VIEWS", width: viewsWidth, align: "right" },
  ];
}
