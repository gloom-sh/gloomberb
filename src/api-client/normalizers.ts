import type {
  ChatAccountType,
  ChatAttachment,
  ChatChannel,
  ChatChannelState,
  ChatDiscordLink,
  ChatMessage,
  ChatMessageOrigin,
  ChatNotification,
  ChatReaction,
  ChatReactionUser,
  ChatStateResponse,
  ChatUserBadge,
  ChatUserSummary,
  CloudSavedSearch,
  CloudSearchHit,
  CloudSearchResponse,
  CloudTweetPayload,
  CloudTweetSearchResponse,
  TeamNotification,
} from "./types";
import { normalizeTimestamp } from "../utils/timestamp";
import { parseChatPaneLink } from "./chat-pane-link";

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

const CHAT_USER_BADGES: readonly string[] = ["team", "pro"] satisfies ChatUserBadge[];

/**
 * A value a newer server adds that this client does not know reads as absent:
 * a human, a message from the app, no badge. A clock or desks that are not
 * what the server promises are dropped rather than shown wrong.
 */
function normalizeChatUser(user: ChatUserSummary): ChatUserSummary {
  if (!user || typeof user !== "object") return user;
  const { accountType, badges, utcOffsetMinutes, desks, ...rest } = user;
  const knownBadges = Array.isArray(badges)
    ? CHAT_USER_BADGES.filter((badge) => badges.includes(badge as ChatUserBadge)) as ChatUserBadge[]
    : [];
  const knownDesks = Array.isArray(desks) ? desks.filter((desk): desk is string => typeof desk === "string" && !!desk) : [];
  const offset = typeof utcOffsetMinutes === "number" && Number.isInteger(utcOffsetMinutes)
    && utcOffsetMinutes >= -12 * 60 && utcOffsetMinutes <= 14 * 60
    ? utcOffsetMinutes
    : null;
  return {
    ...rest,
    ...(accountType !== undefined && CHAT_ACCOUNT_TYPES.includes(accountType) ? { accountType } : {}),
    ...(knownBadges.length > 0 ? { badges: knownBadges } : {}),
    ...(offset !== null ? { utcOffsetMinutes: offset } : {}),
    ...(knownDesks.length > 0 ? { desks: knownDesks } : {}),
  };
}

export function normalizeChatMessage(message: ChatMessage): ChatMessage {
  const normalized: ChatMessage = {
    ...message,
    user: normalizeChatUser(message.user),
    content: typeof message.content === "string" ? message.content : "",
    createdAt: normalizeTimestamp(message.createdAt),
    ...(message.editedAt
      ? { editedAt: normalizeTimestamp(message.editedAt) }
      : {}),
  };
  if ("attachments" in message) normalized.attachments = normalizeChatAttachments(message.attachments);
  if ("reactions" in message) normalized.reactions = normalizeChatReactions(message.reactions);
  if (message.origin !== undefined && !CHAT_MESSAGE_ORIGINS.includes(message.origin)) delete normalized.origin;
  if (message.attachmentReview !== "pending" && message.attachmentReview !== "failed") {
    delete normalized.attachmentReview;
  }
  if ("paneLink" in message) {
    const paneLink = parseChatPaneLink(message.paneLink);
    if (paneLink) normalized.paneLink = paneLink;
    else delete normalized.paneLink;
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

/** Reactions as the server sent them, dropping anything malformed. */
export function normalizeChatReactions(value: unknown): ChatReaction[] {
  if (!Array.isArray(value)) return [];
  const reactions: ChatReaction[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.emoji !== "string" || !raw.emoji) continue;
    const count = typeof raw.count === "number" && Number.isFinite(raw.count) ? Math.max(0, Math.floor(raw.count)) : 0;
    if (count === 0) continue;
    const users = Array.isArray(raw.users)
      ? raw.users.flatMap((user): ChatReactionUser[] => {
        if (!user || typeof user !== "object") return [];
        const candidate = user as Record<string, unknown>;
        if (typeof candidate.id !== "string") return [];
        const accountType = candidate.accountType;
        return [{
          id: candidate.id,
          username: typeof candidate.username === "string" ? candidate.username : null,
          displayName: typeof candidate.displayName === "string" ? candidate.displayName : "User",
          ...(accountType === "human" || accountType === "managed_llm" || accountType === "discord" ? { accountType } : {}),
        }];
      })
      : [];
    reactions.push({ emoji: raw.emoji, count, me: raw.me === true, users });
  }
  return reactions;
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

/** A `chat.channel_state` frame, or null when it is not one. */
export function normalizeChatChannelStateFrame(data: unknown): ChatChannelState | null {
  if (!data || typeof data !== "object") return null;
  const state = data as Partial<ChatChannelState>;
  if (
    typeof state.channelId !== "string"
    || typeof state.notificationsEnabled !== "boolean"
    || typeof state.unreadCount !== "number"
    || (state.lastReadMessageId !== null && typeof state.lastReadMessageId !== "string")
  ) {
    return null;
  }
  return {
    channelId: state.channelId,
    notificationsEnabled: state.notificationsEnabled,
    lastReadMessageId: state.lastReadMessageId,
    unreadCount: state.unreadCount,
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
    ...(typeof channel.lastMessageAt === "string" ? { lastMessageAt: normalizeTimestamp(channel.lastMessageAt) } : {}),
    ...(channel.dmUser ? { dmUser: normalizeChatUser(channel.dmUser) } : {}),
    ...(Array.isArray(channel.members) ? { members: channel.members.map(normalizeChatUser) } : {}),
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
