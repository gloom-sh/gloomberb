import type {
  ChatAccountType,
  ChatAttachment,
  ChatChannel,
  ChatDiscordLink,
  ChatMessage,
  ChatMessageOrigin,
  ChatNotification,
  ChatStateResponse,
  CloudSavedSearch,
  CloudSearchHit,
  CloudSearchResponse,
  CloudTweetPayload,
  CloudTweetSearchResponse,
  TeamNotification,
} from "./types";
import { normalizeTimestamp } from "../utils/timestamp";

/**
 * Saved-search writes answer with either the record itself or `{ search }`.
 * Both shapes are accepted so a server-side envelope change cannot silently
 * hand the pane an object with no `id`.
 */
export function normalizeSavedSearchResponse(
  response: unknown,
): CloudSavedSearch {
  const envelope = response as
    { search?: CloudSavedSearch } | CloudSavedSearch | null;
  const search =
    envelope && "search" in envelope && envelope.search
      ? envelope.search
      : (envelope as CloudSavedSearch | null);
  if (!search?.id)
    throw new Error("The saved search response was missing a record.");
  return search;
}

/**
 * A wire story or filing need not name an issuer, and the server sends `ticker:
 * null` when it does not. Coerced to an empty string at the boundary so the
 * declared `string` is true of every hit: consumers test it for truthiness,
 * join it into search text, and hand it to a badge, and a null reaches each of
 * those as an empty chip, the literal "null", or a crash.
 */
function normalizeSearchHit(hit: CloudSearchHit): CloudSearchHit {
  return hit.ticker ? hit : { ...hit, ticker: "" };
}

export function normalizeSearchResponse(
  response: CloudSearchResponse,
): CloudSearchResponse {
  const hits = response.hits;
  if (!Array.isArray(hits)) return { ...response, hits: [] };
  return { ...response, hits: hits.map(normalizeSearchHit) };
}

function finiteNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** The images a message can show: entries without an id or a link are dropped. */
export function normalizeChatAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ChatAttachment[] => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id || typeof raw.url !== "string" || !raw.url) return [];
    return [{
      id: raw.id,
      mime: typeof raw.mime === "string" ? raw.mime : "",
      width: finiteNumber(raw.width),
      height: finiteNumber(raw.height),
      size: finiteNumber(raw.size),
      url: raw.url,
    }];
  });
}

const CHAT_ACCOUNT_TYPES: readonly string[] = ["human", "managed_llm", "discord"] satisfies ChatAccountType[];
const CHAT_MESSAGE_ORIGINS: readonly string[] = ["app", "discord"] satisfies ChatMessageOrigin[];

/** A value a newer server adds that this client does not know reads as absent: a human, a message from the app. */
function chatUserWithKnownAccountType(user: ChatMessage["user"]): ChatMessage["user"] {
  if (!user || user.accountType === undefined || CHAT_ACCOUNT_TYPES.includes(user.accountType)) return user;
  const { accountType: _unknown, ...known } = user;
  return known;
}

export function normalizeChatMessage(message: ChatMessage): ChatMessage {
  const normalized: ChatMessage = {
    ...message,
    user: chatUserWithKnownAccountType(message.user),
    content: typeof message.content === "string" ? message.content : "",
    createdAt: normalizeTimestamp(message.createdAt),
    ...(message.editedAt
      ? { editedAt: normalizeTimestamp(message.editedAt) }
      : {}),
  };
  if ("attachments" in message) normalized.attachments = normalizeChatAttachments(message.attachments);
  if (message.origin !== undefined && !CHAT_MESSAGE_ORIGINS.includes(message.origin)) delete normalized.origin;
  if (message.attachmentReview !== "pending" && message.attachmentReview !== "failed") {
    delete normalized.attachmentReview;
  }
  return normalized;
}

/** The link answer of a server that knows Discord: mirroring is on and linking available unless it says otherwise. */
export function normalizeChatDiscordLink(value: unknown): ChatDiscordLink {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const username = typeof raw.discordUsername === "string" ? raw.discordUsername.trim() : "";
  return {
    linked: raw.linked === true,
    ...(username ? { discordUsername: username } : {}),
    mirror: raw.mirror !== false,
    available: raw.available !== false,
  };
}

export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => normalizeChatMessage(message));
}

export function normalizeChatNotification(
  notification: ChatNotification,
): ChatNotification {
  return {
    ...notification,
    createdAt: normalizeTimestamp(notification.createdAt),
    message: normalizeChatMessage(notification.message),
  };
}

export function normalizeChatChannel(
  channel: ChatChannel,
  fallbackKind: ChatChannel["kind"] = "public",
): ChatChannel {
  return {
    ...channel,
    kind: channel.kind ?? fallbackKind,
    created_at: normalizeTimestamp(channel.created_at),
  };
}

export function normalizeChatState(
  response: ChatStateResponse,
): ChatStateResponse {
  return {
    ...response,
    channels: response.channels.map((channel) => normalizeChatChannel(channel)),
    notifications: response.notifications.map(normalizeChatNotification),
  };
}

export function normalizeTeamNotification(
  notification: TeamNotification,
): TeamNotification {
  return {
    ...notification,
    createdAt: normalizeTimestamp(notification.createdAt),
  };
}

function normalizeTweet(tweet: CloudTweetPayload): CloudTweetPayload {
  return {
    ...tweet,
    createdAt: normalizeTimestamp(tweet.createdAt),
  };
}

export function normalizeTweetSearchResponse(
  response: CloudTweetSearchResponse,
): CloudTweetSearchResponse {
  return {
    ...response,
    since: normalizeTimestamp(response.since),
    until: normalizeTimestamp(response.until),
    asOf: normalizeTimestamp(response.asOf),
    tweets: response.tweets.map(normalizeTweet),
  };
}
