import {
  apiClient,
  type ChatChannel,
  type ChatChannelState,
  type ChatNotification,
} from "../../../../api-client";
import {
  DEFAULT_CHAT_CHANNEL_ID,
  normalizeChannelId,
  normalizeChannels,
  type ChannelRuntimeState,
} from "./state";

interface ChatControllerChannelsOptions {
  canLoadPrivateState: () => boolean;
  ensureChannelState: (channelId: string) => ChannelRuntimeState;
  getChannelStateIds: () => Iterable<string>;
  handleNotification: (notification: ChatNotification, options?: { countUnread?: boolean }) => void;
  ensureOpenChannelConnections: () => void;
  emit: (channelId?: string) => void;
}

export class ChatControllerChannels {
  private channels: ChatChannel[] = [];
  private onlineCount = 0;
  private channelsLoading = false;
  private channelsPromise: Promise<void> | null = null;
  private presencePromise: Promise<void> | null = null;

  constructor(private readonly options: ChatControllerChannelsOptions) {}

  getChannels(): ChatChannel[] {
    return this.channels;
  }

  getOnlineCount(): number {
    return this.onlineCount;
  }

  setOnlineCount(onlineCount: number): void {
    this.onlineCount = onlineCount;
  }

  isLoading(): boolean {
    return this.channelsLoading;
  }

  getChannelStateSnapshots(): ChatChannelState[] {
    const channelIds = new Set<string>([
      ...this.channels.map((channel) => channel.id),
      ...this.options.getChannelStateIds(),
    ]);
    return [...channelIds].map((channelId) => {
      const channel = this.options.ensureChannelState(channelId);
      return {
        channelId,
        notificationsEnabled: channel.notificationsEnabled,
        lastReadMessageId: channel.lastViewedMessageId,
        unreadCount: channel.unreadCount,
      };
    });
  }

  async refreshChannels(): Promise<void> {
    if (this.channelsPromise) return this.channelsPromise;
    this.channelsLoading = true;
    this.options.emit();

    const request = apiClient.getChannels()
      .then((channels) => {
        this.channels = normalizeChannels(channels);
      })
      .catch(() => {
        // Keep the last backend-provided list if the refresh fails.
      })
      .finally(() => {
        this.channelsLoading = false;
        this.channelsPromise = null;
        this.options.emit();
      });

    this.channelsPromise = request;
    return request;
  }

  /** Single-flight: every open chat pane calls this on mount. */
  async refreshPresence(): Promise<void> {
    if (this.presencePromise) return this.presencePromise;
    const request = apiClient.getChatPresence()
      .then((presence) => {
        this.onlineCount = presence.onlineCount;
        this.options.emit();
      })
      .finally(() => {
        this.presencePromise = null;
      });
    this.presencePromise = request;
    return request;
  }

  async refreshChatState(): Promise<void> {
    if (!this.options.canLoadPrivateState()) {
      await this.refreshPresence();
      return;
    }
    const state = await apiClient.getChatState();
    this.channels = normalizeChannels(state.channels);
    this.onlineCount = state.onlineCount;
    for (const entry of state.channelStates) {
      const channel = this.options.ensureChannelState(entry.channelId);
      channel.notificationsEnabled = entry.notificationsEnabled;
      channel.unreadCount = entry.unreadCount;
      channel.lastViewedMessageId = entry.lastReadMessageId ?? channel.lastViewedMessageId;
    }
    for (const notification of state.notifications) {
      this.options.handleNotification(notification, { countUnread: false });
    }
    this.options.ensureOpenChannelConnections();
    this.options.emit();
  }

  async openDirectChannel(target: { userId?: string; username?: string }): Promise<ChatChannel> {
    return this.registerOpenedChannel(await apiClient.openDirectChannel(target));
  }

  async openGroupChannel(body: { userIds?: string[]; usernames?: string[]; name?: string }): Promise<ChatChannel> {
    return this.registerOpenedChannel(await apiClient.openGroupChannel(body));
  }

  async resolveRequiredChannelId(channelId: string): Promise<string> {
    const normalizedChannelId = normalizeChannelId(channelId);
    if (this.isKnownChannelId(normalizedChannelId)) {
      return normalizedChannelId;
    }
    await this.refreshChannels();
    if (this.isKnownChannelId(normalizedChannelId)) {
      return normalizedChannelId;
    }
    throw new Error(`Unknown chat channel "#${normalizedChannelId}".`);
  }

  async resolvePreferredChannelId(channelId: string | null | undefined): Promise<string> {
    const normalizedChannelId = normalizeChannelId(channelId);
    if (this.isKnownChannelId(normalizedChannelId)) {
      return normalizedChannelId;
    }
    await this.refreshChannels();
    if (this.isKnownChannelId(normalizedChannelId)) {
      return normalizedChannelId;
    }
    if (this.isKnownChannelId(DEFAULT_CHAT_CHANNEL_ID)) {
      return DEFAULT_CHAT_CHANNEL_ID;
    }
    return this.channels[0]?.id ?? DEFAULT_CHAT_CHANNEL_ID;
  }

  private registerOpenedChannel(channel: ChatChannel): ChatChannel {
    this.channels = normalizeChannels([...this.channels, channel]);
    this.options.ensureChannelState(channel.id);
    this.options.ensureOpenChannelConnections();
    this.options.emit(channel.id);
    this.options.emit();
    return channel;
  }

  private isKnownChannelId(channelId: string): boolean {
    return this.channels.some((channel) => channel.id === channelId);
  }
}
