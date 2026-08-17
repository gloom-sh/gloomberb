import type { ChatMessage } from "../../../../api-client";
import { toTimestampMillis } from "../../../../utils/timestamp";
import type { ChannelRuntimeState, MergeMessagesOptions } from "./state";
import { PENDING_RECONCILE_WINDOW_MS } from "./state";
import { chatMessageMentionsUsername, compareMessages, normalizeChatUsername } from "./utils";

type CurrentChatUser = { id: string; username: string } | null | undefined;

export function hasPendingSend(channel: ChannelRuntimeState, content: string, replyToId?: string): boolean {
  const replyToKey = replyToId ?? null;
  return channel.pendingMessages.some((message) => (
    message.clientStatus === "sending"
    && message.content === content
    && message.replyToId === replyToKey
  ));
}

export function getVisibleMessages(channel: ChannelRuntimeState): ChatMessage[] {
  return [...channel.messages, ...channel.pendingMessages]
    .sort(compareMessages);
}

function mergeStoredMessages(channel: ChannelRuntimeState, messages: ChatMessage[]): ChatMessage[] {
  const merged = new Map<string, ChatMessage>();
  const incoming = new Map<string, ChatMessage>();
  for (const message of channel.messages) merged.set(message.id, message);
  for (const message of messages) {
    if (!merged.has(message.id)) {
      incoming.set(message.id, message);
    }
    merged.set(message.id, message);
  }
  for (const message of messages) {
    for (const [id, current] of merged) {
      if (current.replyToId !== message.id || current.replyTo?.content === message.content) continue;
      merged.set(id, {
        ...current,
        replyTo: current.replyTo
          ? {
            ...current.replyTo,
            content: message.content,
            user: {
              id: message.user.id,
              username: message.user.username ?? current.replyTo.user.username,
            },
          }
          : current.replyTo,
      });
    }
  }
  channel.messages = [...merged.values()]
    .sort(compareMessages);
  channel.lastCursor = channel.messages[channel.messages.length - 1]?.id ?? channel.lastCursor;
  return [...incoming.values()];
}

export function createPendingMessage({
  channelId,
  content,
  replyToId,
  pendingId,
  user,
  visibleMessages,
}: {
  channelId: string;
  content: string;
  replyToId?: string;
  pendingId: string;
  user: CurrentChatUser;
  visibleMessages: ChatMessage[];
}): ChatMessage {
  const replyToMessage = replyToId
    ? visibleMessages.find((message) => message.id === replyToId) ?? null
    : null;
  return {
    id: pendingId,
    channelId,
    content,
    replyToId: replyToId ?? null,
    createdAt: new Date().toISOString(),
    user: {
      id: user?.id ?? "local",
      username: user?.username ?? "you",
      displayName: user?.username ?? "You",
    },
    replyTo: replyToMessage
      ? {
        content: replyToMessage.content,
        user: { id: replyToMessage.user.id, username: replyToMessage.user.username ?? "unknown" },
      }
      : null,
    clientStatus: "sending",
    clientError: null,
  };
}

function reconcilePendingMessages(channel: ChannelRuntimeState, messages: ChatMessage[]): void {
  if (channel.pendingMessages.length === 0 || messages.length === 0) return;

  const remaining = [...channel.pendingMessages];
  for (const incoming of messages) {
    const incomingMs = toTimestampMillis(incoming.createdAt);
    const pendingIndex = remaining.findIndex((pending) => (
      pending.user.id === incoming.user.id
      && pending.content === incoming.content
      && pending.replyToId === incoming.replyToId
      && Math.abs(toTimestampMillis(pending.createdAt) - incomingMs) <= PENDING_RECONCILE_WINDOW_MS
    ));
    if (pendingIndex >= 0) {
      remaining.splice(pendingIndex, 1);
    }
  }
  channel.pendingMessages = remaining;
}

export function getUnreadMentionMessages(channel: ChannelRuntimeState, user: CurrentChatUser): ChatMessage[] {
  if (!channel.lastViewedMessageId) {
    return getMentionMessages(channel.messages, user);
  }

  const viewedIndex = channel.messages.findIndex((message) => message.id === channel.lastViewedMessageId);
  const unseenMessages = viewedIndex >= 0
    ? channel.messages.slice(viewedIndex + 1)
    : channel.messages;
  return getMentionMessages(unseenMessages, user);
}

function getMentionMessages(messages: ChatMessage[], user: CurrentChatUser): ChatMessage[] {
  const normalizedUsername = normalizeChatUsername(user?.username);
  if (!normalizedUsername || messages.length === 0) return [];

  return messages.filter((message) => (
    message.user.id !== user?.id && chatMessageMentionsUsername(message.content, normalizedUsername)
  ));
}

interface MergeChatMessagesOptions {
  channel: ChannelRuntimeState;
  currentUserId?: string | null;
  messages: ChatMessage[];
  options?: MergeMessagesOptions;
  viewActive: boolean;
  markViewed: (persist?: boolean) => void;
}

export function mergeChatMessages({
  channel,
  currentUserId,
  messages,
  options,
  viewActive,
  markViewed,
}: MergeChatMessagesOptions): void {
  reconcilePendingMessages(channel, messages);
  const freshIncoming = mergeStoredMessages(channel, messages)
    .filter((message) => message.user.id !== currentUserId);
  if (viewActive) {
    markViewed(false);
  } else if (freshIncoming.length > 0 && options?.countUnread !== false) {
    channel.unreadCount += freshIncoming.length;
  }
}

interface MarkChatChannelViewedOptions {
  channel: ChannelRuntimeState;
  canSyncReadState: boolean;
  persist: boolean;
  persistChannelState: () => void;
  syncReadState: (messageId: string) => void;
}

export function markChatChannelViewedThroughLatestMessage({
  channel,
  canSyncReadState,
  persist,
  persistChannelState,
  syncReadState,
}: MarkChatChannelViewedOptions): boolean {
  const latestMessageId = channel.messages[channel.messages.length - 1]?.id ?? null;
  const previousUnreadCount = channel.unreadCount;
  if (channel.lastViewedMessageId === latestMessageId && previousUnreadCount === 0) {
    return false;
  }
  channel.lastViewedMessageId = latestMessageId;
  channel.unreadCount = 0;
  if (persist) {
    persistChannelState();
  }
  if (latestMessageId && canSyncReadState) {
    syncReadState(latestMessageId);
  }
  return true;
}
