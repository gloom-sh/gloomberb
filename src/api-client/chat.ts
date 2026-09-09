import {
  normalizeChatChannel,
  normalizeChatMessage,
  normalizeChatMessages,
  normalizeChatState,
} from "./normalizers";
import type { CloudApiSocket } from "./socket";
import type {
  ChatChannel,
  ChatChannelState,
  ChatMessage,
  ChatNotification,
  ChatStateResponse,
} from "./types";

type CloudApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
type ChatNotificationListener = (notification: ChatNotification) => void;
type ChatPresenceListener = (onlineCount: number) => void;

interface CloudChatApiOptions {
  request: CloudApiRequest;
  socket: CloudApiSocket;
}

export class CloudChatApi {
  constructor(private readonly options: CloudChatApiOptions) {}

  async getChannels(): Promise<ChatChannel[]> {
    const channels =
      await this.options.request<ChatChannel[]>("/chat/channels");
    return channels.map((channel) => normalizeChatChannel(channel));
  }

  async getPresence(): Promise<{ onlineCount: number }> {
    return this.options.request<{ onlineCount: number }>("/chat/presence");
  }

  async getState(): Promise<ChatStateResponse> {
    const state = await this.options.request<ChatStateResponse>("/chat/state");
    return normalizeChatState(state);
  }

  async updateChannelState(
    channelId: string,
    body: { notificationsEnabled?: boolean; readThroughMessageId?: string },
  ): Promise<ChatChannelState> {
    return this.options.request<ChatChannelState>(
      `/chat/channels/${channelId}/state`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    );
  }

  async markNotificationsDelivered(
    notificationIds: string[],
  ): Promise<{ delivered: number }> {
    return this.options.request<{ delivered: number }>(
      "/chat/notifications/delivered",
      {
        method: "POST",
        body: JSON.stringify({ notificationIds }),
      },
    );
  }

  async openDirectChannel(target: {
    userId?: string;
    username?: string;
  }): Promise<ChatChannel> {
    const channel = await this.options.request<ChatChannel>("/chat/direct", {
      method: "POST",
      body: JSON.stringify(target),
    });
    return normalizeChatChannel(channel, "direct");
  }

  async openGroupChannel(body: {
    userIds?: string[];
    usernames?: string[];
    name?: string;
  }): Promise<ChatChannel> {
    const channel = await this.options.request<ChatChannel>("/chat/groups", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return normalizeChatChannel(channel, "group");
  }

  async getMessages(
    channelId: string,
    opts?: { after?: string; before?: string; limit?: number },
  ): Promise<ChatMessage[]> {
    const params = new URLSearchParams();
    if (opts?.after) params.set("after", opts.after);
    if (opts?.before) params.set("before", opts.before);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const messages = await this.options.request<ChatMessage[]>(
      `/chat/channels/${channelId}/messages${qs ? `?${qs}` : ""}`,
    );
    return normalizeChatMessages(messages);
  }

  async sendMessage(
    channelId: string,
    content: string,
    replyToId?: string,
    clientMessageId?: string,
  ): Promise<ChatMessage> {
    const message = await this.options.request<ChatMessage>(
      `/chat/channels/${channelId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content, replyToId, clientMessageId }),
      },
    );
    return normalizeChatMessage(message);
  }

  async editMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<ChatMessage> {
    const message = await this.options.request<ChatMessage>(
      `/chat/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ content }),
      },
    );
    return normalizeChatMessage(message);
  }

  connectChannel(
    channelId: string,
    onMessage: (msg: ChatMessage) => void,
    onError?: (err: string) => void,
  ): ReturnType<CloudApiSocket["connectChannel"]> {
    return this.options.socket.connectChannel(
      channelId,
      onMessage,
      onError,
      (content, replyToId, clientMessageId) =>
        this.sendMessage(channelId, content, replyToId, clientMessageId),
    );
  }

  subscribeNotifications(listener: ChatNotificationListener): () => void {
    return this.options.socket.subscribeChatNotifications(listener);
  }

  subscribePresence(listener: ChatPresenceListener): () => void {
    return this.options.socket.subscribeChatPresence(listener);
  }
}
