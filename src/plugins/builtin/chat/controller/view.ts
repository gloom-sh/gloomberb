import type {
  ChatChannel,
  ChatChannelState,
  ChatMessage,
} from "../../../../api-client";
import {
  DEFAULT_CHAT_CHANNEL_ID,
  normalizeChannelId,
  type ChannelRuntimeState,
  type ChatControllerSnapshot,
} from "./state";

interface ChatControllerViewOptions {
  ensureChannelState: (channelId: string) => ChannelRuntimeState;
  getChannels: () => ChatChannel[];
  getChannelStateSnapshots: () => ChatChannelState[];
  isChannelsLoading: () => boolean;
  isSessionChecked: () => boolean;
  hasSessionToken: () => boolean;
  getOnlineCount: () => number;
  getUser: () => ChatControllerSnapshot["user"];
  getListenerSnapshot: (channelId: string) => ChatControllerSnapshot;
  getVisibleMessages: (channelId: string) => ChatMessage[];
  getUnreadMentionCount: (channelId: string) => number;
}

interface ChannelListenerEntry {
  channelId: string;
  listener: (snapshot: ChatControllerSnapshot) => void;
}

export class ChatControllerView {
  private readonly listeners = new Set<ChannelListenerEntry>();

  constructor(private readonly options: ChatControllerViewOptions) {}

  get listenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: (snapshot: ChatControllerSnapshot) => void): () => void;
  subscribe(channelId: string, listener: (snapshot: ChatControllerSnapshot) => void): () => void;
  subscribe(
    channelIdOrListener: string | ((snapshot: ChatControllerSnapshot) => void),
    maybeListener?: (snapshot: ChatControllerSnapshot) => void,
  ): () => void {
    const channelId = typeof channelIdOrListener === "string"
      ? normalizeChannelId(channelIdOrListener)
      : DEFAULT_CHAT_CHANNEL_ID;
    const listener = typeof channelIdOrListener === "function" ? channelIdOrListener : maybeListener;
    if (!listener) return () => {};
    const entry = { channelId, listener };
    this.listeners.add(entry);
    listener(this.options.getListenerSnapshot(channelId));
    return () => {
      this.listeners.delete(entry);
    };
  }

  getSnapshot(channelId = DEFAULT_CHAT_CHANNEL_ID): ChatControllerSnapshot {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.options.ensureChannelState(normalizedChannelId);
    return {
      channelId: normalizedChannelId,
      channels: this.options.getChannels(),
      channelStates: this.options.getChannelStateSnapshots(),
      channelsLoading: this.options.isChannelsLoading(),
      loading: !this.options.isSessionChecked() || channel.messagesLoading,
      messagesError: channel.messagesError,
      loadingOlderMessages: channel.olderMessagesLoading,
      hasOlderMessages: channel.messages.length > 0 && !channel.reachedOldestMessage,
      hasSavedSession: this.options.hasSessionToken(),
      onlineCount: this.options.getOnlineCount(),
      user: this.options.getUser(),
      messages: this.options.getVisibleMessages(normalizedChannelId),
      draft: channel.draft,
      replyToId: channel.replyToId,
      unreadMentionCount: this.options.getUnreadMentionCount(normalizedChannelId),
    };
  }

  emit(channelId?: string): void {
    for (const entry of this.listeners) {
      if (channelId && entry.channelId !== channelId && entry.channelId !== DEFAULT_CHAT_CHANNEL_ID) continue;
      const snapshot = this.options.getListenerSnapshot(entry.channelId);
      try {
        entry.listener(snapshot);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
