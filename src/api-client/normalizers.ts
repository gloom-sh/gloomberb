import type {
  ChatChannel,
  ChatMessage,
  ChatNotification,
  ChatStateResponse,
  CloudSavedSearch,
  CloudSearchHit,
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
  return Array.isArray(hits) ? hits as CloudSearchHit[] : [];
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
