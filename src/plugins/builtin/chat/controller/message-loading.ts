import type { ChatMessage } from "../../../../api-client";
import {
  DEFAULT_CHAT_CHANNEL_ID,
  normalizeChannelId,
  type ChannelRuntimeState,
  type MergeMessagesOptions,
} from "./state";
import {
  fetchLatestChannelMessages,
  fetchOlderChannelMessages,
} from "./fetch";

interface ChatControllerMessageLoadingOptions {
  ensureChannelState: (channelId: string) => ChannelRuntimeState;
  emit: (channelId?: string) => void;
  mergeMessages: (channelId: string, messages: ChatMessage[], options?: MergeMessagesOptions) => void;
  persistChannelState: (channelId: string) => void;
}

export class ChatControllerMessageLoading {
  constructor(private readonly options: ChatControllerMessageLoadingOptions) {}

  refreshMessages(): Promise<void> {
    return this.refreshChannelMessages(DEFAULT_CHAT_CHANNEL_ID);
  }

  refreshChannelMessages(channelId: string): Promise<void> {
    return this.runMessagesRefresh(normalizeChannelId(channelId), { showLoading: true });
  }

  runMessagesRefresh(channelId: string, options: { showLoading: boolean }): Promise<void> {
    const channel = this.options.ensureChannelState(channelId);
    if (channel.refreshMessagesPromise) return channel.refreshMessagesPromise;

    channel.messagesError = null;
    if (options.showLoading) {
      channel.messagesLoading = true;
      this.options.emit(channelId);
    }

    const request = fetchLatestChannelMessages(channelId, channel, {
      mergeMessages: (nextChannelId, messages, mergeOptions) => {
        this.options.mergeMessages(nextChannelId, messages, mergeOptions);
      },
      persistChannelState: (nextChannelId) => {
        this.options.persistChannelState(nextChannelId);
      },
    })
      .catch((error: unknown) => {
        channel.messagesError = error instanceof Error && error.message.trim()
          ? error.message
          : "Could not load messages.";
        this.options.persistChannelState(channelId);
      })
      .finally(() => {
        if (options.showLoading) {
          channel.messagesLoading = false;
        }
        channel.refreshMessagesPromise = null;
        this.options.emit(channelId);
      });

    channel.refreshMessagesPromise = request;
    return request;
  }

  loadOlderMessages(): Promise<void> {
    return this.loadOlderChannelMessages(DEFAULT_CHAT_CHANNEL_ID);
  }

  loadOlderChannelMessages(channelId: string): Promise<void> {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.options.ensureChannelState(normalizedChannelId);
    if (channel.loadOlderMessagesPromise) return channel.loadOlderMessagesPromise;
    const before = channel.messages[0]?.id ?? null;
    if (!before || channel.reachedOldestMessage) return Promise.resolve();

    channel.olderMessagesLoading = true;
    this.options.emit(normalizedChannelId);

    const request = fetchOlderChannelMessages(normalizedChannelId, before, channel, {
      mergeMessages: (nextChannelId, messages, mergeOptions) => {
        this.options.mergeMessages(nextChannelId, messages, mergeOptions);
      },
      persistChannelState: (nextChannelId) => {
        this.options.persistChannelState(nextChannelId);
      },
    })
      .catch(() => {
        this.options.persistChannelState(normalizedChannelId);
      })
      .finally(() => {
        channel.olderMessagesLoading = false;
        channel.loadOlderMessagesPromise = null;
        this.options.emit(normalizedChannelId);
      });

    channel.loadOlderMessagesPromise = request;
    return request;
  }
}
