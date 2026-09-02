import type {
  ChatChannel,
  ChatMessage,
  ChatNotification,
  ChatStateResponse,
  CloudSavedSearch,
  CloudSearchHit,
  CloudSearchResponse,
  CloudTweetPayload,
  CloudTweetSearchResponse,
} from "./types";
import { normalizeTimestamp } from "../utils/timestamp";

/**
 * Saved-search writes answer with either the record itself or `{ search }`.
 * Both shapes are accepted so a server-side envelope change cannot silently
 * hand the pane an object with no `id`.
 */
export function normalizeSavedSearchResponse(response: unknown): CloudSavedSearch {
  const envelope = response as { search?: CloudSavedSearch } | CloudSavedSearch | null;
  const search = envelope && "search" in envelope && envelope.search
    ? envelope.search
    : envelope as CloudSavedSearch | null;
  if (!search?.id) throw new Error("The saved search response was missing a record.");
  return search;
}

export function normalizeSavedSearchHits(response: unknown): CloudSearchHit[] {
  const hits = (response as { hits?: unknown } | null)?.hits;
  return Array.isArray(hits) ? (hits as CloudSearchHit[]).map(normalizeSearchHit) : [];
}

/**
 * A wire story or filing need not name an issuer, and the server sends `ticker:
 * null` when it does not. Coerced to an empty string at the boundary so the
 * declared `string` is true of every hit: consumers test it for truthiness,
 * join it into search text, and hand it to a badge, and a null reaches each of
 * those as an empty chip, the literal "null", or a crash.
 */
export function normalizeSearchHit(hit: CloudSearchHit): CloudSearchHit {
  return hit.ticker ? hit : { ...hit, ticker: "" };
}

export function normalizeSearchResponse(response: CloudSearchResponse): CloudSearchResponse {
  const hits = response.hits;
  if (!Array.isArray(hits)) return { ...response, hits: [] };
  return { ...response, hits: hits.map(normalizeSearchHit) };
}

export function normalizeChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    createdAt: normalizeTimestamp(message.createdAt),
    ...(message.editedAt ? { editedAt: normalizeTimestamp(message.editedAt) } : {}),
  };
}

export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => normalizeChatMessage(message));
}

export function normalizeChatNotification(notification: ChatNotification): ChatNotification {
  return {
    ...notification,
    createdAt: normalizeTimestamp(notification.createdAt),
    message: normalizeChatMessage(notification.message),
  };
}

export function normalizeChatChannel(channel: ChatChannel, fallbackKind: ChatChannel["kind"] = "public"): ChatChannel {
  return {
    ...channel,
    kind: channel.kind ?? fallbackKind,
    created_at: normalizeTimestamp(channel.created_at),
  };
}

export function normalizeChatState(response: ChatStateResponse): ChatStateResponse {
  return {
    ...response,
    channels: response.channels.map((channel) => normalizeChatChannel(channel)),
    notifications: response.notifications.map(normalizeChatNotification),
  };
}

function normalizeTweet(tweet: CloudTweetPayload): CloudTweetPayload {
  return {
    ...tweet,
    createdAt: normalizeTimestamp(tweet.createdAt),
  };
}

export function normalizeTweetSearchResponse(response: CloudTweetSearchResponse): CloudTweetSearchResponse {
  return {
    ...response,
    since: normalizeTimestamp(response.since),
    until: normalizeTimestamp(response.until),
    asOf: normalizeTimestamp(response.asOf),
    tweets: response.tweets.map(normalizeTweet),
  };
}
