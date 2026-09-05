import type {
  ChatChannel,
  ChatChannelState,
  ChatMessage,
  PersistedAuthUser,
} from "../../../../api-client";
import { createClientMessageId, getLatestMessageId, resolveHydratedCursor } from "./utils";

export const SESSION_STATE_KEY = "session";
export const DEFAULT_CHAT_CHANNEL_ID = "everyone";
export const TRANSCRIPT_KIND = "channel-transcript";
export const TRANSCRIPT_SOURCE = "server";
export const MESSAGE_PAGE_SIZE = 50;
export const MAX_CACHED_MESSAGES = 50;
export const SESSION_SCHEMA_VERSION = 1;
export const CHANNEL_SCHEMA_VERSION = 1;
export const TRANSCRIPT_SCHEMA_VERSION = 2;
export const TRANSCRIPT_CACHE_POLICY = {
  staleMs: 30 * 24 * 60 * 60_000,
  expireMs: 90 * 24 * 60 * 60_000,
};
export const DRAFT_SYNC_DEBOUNCE_MS = 250;
export const VERIFICATION_POLL_MS = 5_000;
export const SESSION_RETRY_MS = 30_000;
export const SAFETY_REFRESH_MS = 30_000;
export const PENDING_RECONCILE_WINDOW_MS = 2 * 60_000;

export interface PersistedSessionState {
  sessionToken: string | null;
  websocketToken?: string | null;
  user: PersistedAuthUser | null;
}

export interface PersistedChannelState {
  draft: string;
  draftClientMessageId?: string | null;
  replyToId: string | null;
  lastCursor: string | null;
  lastViewedMessageId?: string | null;
}

export interface PersistedTranscript {
  messages: ChatMessage[];
}

export interface ChatControllerSnapshot {
  channelId: string;
  channels: ChatChannel[];
  channelStates: ChatChannelState[];
  channelsLoading: boolean;
  loading: boolean;
  /** Last message-load failure for this channel, or null. */
  messagesError: string | null;
  loadingOlderMessages: boolean;
  hasOlderMessages: boolean;
  hasSavedSession: boolean;
  onlineCount: number;
  user: { id: string; username: string; emailVerified: boolean } | null;
  messages: ChatMessage[];
  draft: string;
  replyToId: string | null;
  unreadMentionCount: number;
}

type ChatConnection = {
  send: (content: string, replyToId?: string, clientMessageId?: string) => Promise<ChatMessage>;
  close: () => void;
};

export type MergeMessagesOptions = { countUnread?: boolean };

export interface ChannelRuntimeState {
  hydrated: boolean;
  messagesLoading: boolean;
  /** Last message-load failure, so an empty transcript is never mistaken for "no messages". */
  messagesError: string | null;
  olderMessagesLoading: boolean;
  refreshMessagesPromise: Promise<void> | null;
  loadOlderMessagesPromise: Promise<void> | null;
  reachedOldestMessage: boolean;
  /**
   * False until this session has fetched a full latest page. The incremental
   * cursor only ever asks for newer messages, so a message missed live can
   * never be requested again; one uncursored fetch per session repairs it.
   */
  backfilled: boolean;
  messages: ChatMessage[];
  pendingMessages: ChatMessage[];
  draft: string;
  draftClientMessageId: string | null;
  replyToId: string | null;
  lastCursor: string | null;
  lastViewedMessageId: string | null;
  notificationsEnabled: boolean;
  unreadCount: number;
  wsConnection: ChatConnection | null;
  wsConnected: boolean;
  draftSyncTimer: ReturnType<typeof setTimeout> | null;
  openViewCount: number;
  focusedViewCount: number;
}

export function channelStateKey(channelId: string): string {
  return `channel:${channelId}`;
}

export function normalizeChannelId(channelId: string | null | undefined): string {
  const normalized = channelId?.trim();
  return normalized || DEFAULT_CHAT_CHANNEL_ID;
}

export function createEmptyChannelState(): ChannelRuntimeState {
  return {
    hydrated: false,
    messagesLoading: false,
    messagesError: null,
    olderMessagesLoading: false,
    refreshMessagesPromise: null,
    loadOlderMessagesPromise: null,
    reachedOldestMessage: false,
    backfilled: false,
    messages: [],
    pendingMessages: [],
    draft: "",
    draftClientMessageId: null,
    replyToId: null,
    lastCursor: null,
    lastViewedMessageId: null,
    notificationsEnabled: false,
    unreadCount: 0,
    wsConnection: null,
    wsConnected: false,
    draftSyncTimer: null,
    openViewCount: 0,
    focusedViewCount: 0,
  };
}

export function normalizeChannels(channels: ChatChannel[]): ChatChannel[] {
  const byId = new Map<string, ChatChannel>();
  for (const channel of channels) {
    const id = channel.id.trim();
    if (!id) continue;
    byId.set(id, {
      ...channel,
      id,
      name: channel.name.trim() || id,
      kind: channel.kind ?? "public",
    });
  }
  return [...byId.values()];
}

export function hydrateChannelRuntimeState({
  channel,
  messages,
  persistedChannel,
  userId,
}: {
  channel: ChannelRuntimeState;
  messages: ChatMessage[];
  persistedChannel: PersistedChannelState | null;
  userId: string | null;
}): void {
  channel.draft = persistedChannel?.draft ?? "";
  channel.draftClientMessageId = channel.draft.trim()
    ? persistedChannel?.draftClientMessageId ?? createClientMessageId()
    : null;
  channel.replyToId = persistedChannel?.replyToId ?? null;
  channel.messages = messages;
  channel.lastCursor = resolveHydratedCursor(messages, persistedChannel?.lastCursor ?? null);
  channel.lastViewedMessageId = userId
    ? persistedChannel?.lastViewedMessageId ?? getLatestMessageId(messages)
    : null;
}
