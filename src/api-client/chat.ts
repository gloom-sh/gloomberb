import {
  normalizeChatAttachments,
  normalizeChatChannel,
  normalizeChatDiscordLink,
  normalizeChatMessage,
  normalizeChatMessages,
  normalizeChatState,
} from "./normalizers";
import { CHAT_ATTACHMENTS_FEATURE, type CloudApiSocket } from "./socket";
import type {
  ChatAttachment,
  ChatChannel,
  ChatChannelState,
  ChatDiscordLink,
  ChatMessage,
  ChatNotification,
  ChatStateResponse,
} from "./types";
import type { CloudApiRequest } from "./request";
type ChatNotificationListener = (notification: ChatNotification) => void;
type ChatPresenceListener = (onlineCount: number) => void;

/** REST requests list the protocol features this client reads, comma separated. */
const CHAT_FEATURES_HEADER = "X-Gloom-Features";

/** The bytes of one image to upload, with the type and name the picker or clipboard gave it. */
export interface ChatAttachmentUpload {
  name: string;
  type: string;
  data: Blob | Uint8Array;
}

export interface ChatAttachmentUploadOptions {
  signal?: AbortSignal;
  /** The fraction of the body sent, where the transport can tell. */
  onProgress?: (fraction: number) => void;
}

type CloudChatUpload = <T>(
  path: string,
  body: Blob | Uint8Array,
  options: {
    contentType: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
  },
) => Promise<T>;

interface CloudChatApiOptions {
  request: CloudApiRequest;
  upload: CloudChatUpload;
  socket: CloudApiSocket;
}

function withChatFeatures(options: RequestInit = {}): RequestInit {
  const headers = new Headers(options.headers);
  headers.set(CHAT_FEATURES_HEADER, CHAT_ATTACHMENTS_FEATURE);
  return { ...options, headers };
}

/** A server that knows images sends `attachments` on every message, empty or not. */
function carriesAttachments(messages: readonly unknown[]): boolean {
  return messages.some((message) => (
    !!message && typeof message === "object" && Array.isArray((message as { attachments?: unknown }).attachments)
  ));
}

export class CloudChatApi {
  /** Set once a REST answer showed the server knows images, whatever the socket said. */
  private restAttachmentSupport = false;
  private readonly attachmentSupportListeners = new Set<() => void>();
  private unsubscribeServerFeatures: (() => void) | null = null;
  private announcedSupport = false;

  constructor(private readonly options: CloudChatApiOptions) {}

  private request<T>(path: string, options?: RequestInit): Promise<T> {
    return this.options.request<T>(path, withChatFeatures(options));
  }

  /**
   * Whether the server takes images: its socket "ready" frame offered
   * chat.attachments, or a REST answer carried them. Until then the client
   * keeps to text, so an older server never sees an upload.
   */
  attachmentsSupported(): boolean {
    return this.restAttachmentSupport || this.options.socket.serverOffers(CHAT_ATTACHMENTS_FEATURE);
  }

  subscribeAttachmentSupport(listener: () => void): () => void {
    if (this.attachmentSupportListeners.size === 0) this.announcedSupport = this.attachmentsSupported();
    this.attachmentSupportListeners.add(listener);
    this.unsubscribeServerFeatures ??= this.options.socket.subscribeServerFeatures(() => {
      this.emitAttachmentSupport();
    });
    return () => {
      this.attachmentSupportListeners.delete(listener);
      if (this.attachmentSupportListeners.size > 0) return;
      this.unsubscribeServerFeatures?.();
      this.unsubscribeServerFeatures = null;
    };
  }

  private emitAttachmentSupport(): void {
    const supported = this.attachmentsSupported();
    if (supported === this.announcedSupport) return;
    this.announcedSupport = supported;
    for (const listener of this.attachmentSupportListeners) listener();
  }

  private noteMessages(messages: readonly unknown[]): void {
    if (this.restAttachmentSupport || !carriesAttachments(messages)) return;
    this.restAttachmentSupport = true;
    this.emitAttachmentSupport();
  }

  async getChannels(): Promise<ChatChannel[]> {
    const channels =
      await this.request<ChatChannel[]>("/chat/channels");
    return channels.map((channel) => normalizeChatChannel(channel));
  }

  async getPresence(): Promise<{ onlineCount: number }> {
    return this.request<{ onlineCount: number }>("/chat/presence");
  }

  async getState(): Promise<ChatStateResponse> {
    const state = await this.request<ChatStateResponse>("/chat/state");
    this.noteMessages((state.notifications ?? []).map((notification) => notification?.message));
    return normalizeChatState(state);
  }

  async updateChannelState(
    channelId: string,
    body: { notificationsEnabled?: boolean; readThroughMessageId?: string },
  ): Promise<ChatChannelState> {
    return this.request<ChatChannelState>(
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
    return this.request<{ delivered: number }>(
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
    const channel = await this.request<ChatChannel>("/chat/direct", {
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
    const channel = await this.request<ChatChannel>("/chat/groups", {
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
    const messages = await this.request<ChatMessage[]>(
      `/chat/channels/${channelId}/messages${qs ? `?${qs}` : ""}`,
    );
    this.noteMessages(messages);
    return normalizeChatMessages(messages);
  }

  /**
   * Uploads one image to a channel ahead of the message that shows it. The
   * answer describes the stored copy (it may be smaller, or WebP) and its `id`
   * goes into `sendMessage`'s `attachmentIds`.
   */
  async uploadAttachment(
    channelId: string,
    upload: ChatAttachmentUpload,
    options: ChatAttachmentUploadOptions = {},
  ): Promise<ChatAttachment> {
    const stored = await this.options.upload<ChatAttachment>(
      `/chat/channels/${channelId}/attachments`,
      upload.data,
      {
        contentType: upload.type || "application/octet-stream",
        headers: { [CHAT_FEATURES_HEADER]: CHAT_ATTACHMENTS_FEATURE },
        signal: options.signal,
        onProgress: options.onProgress,
      },
    );
    const [attachment] = normalizeChatAttachments([stored]);
    if (!attachment) throw new Error("The upload answer had no image.");
    return attachment;
  }

  async sendMessage(
    channelId: string,
    content: string,
    replyToId?: string,
    clientMessageId?: string,
    attachmentIds?: string[],
  ): Promise<ChatMessage> {
    const message = await this.request<ChatMessage>(
      `/chat/channels/${channelId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content,
          replyToId,
          clientMessageId,
          ...(attachmentIds?.length ? { attachmentIds } : {}),
        }),
      },
    );
    this.noteMessages([message]);
    return normalizeChatMessage(message);
  }

  async editMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<ChatMessage> {
    const message = await this.request<ChatMessage>(
      `/chat/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ content }),
      },
    );
    return normalizeChatMessage(message);
  }

  /** Whether this account is tied to a Discord person. Throws a 404 or 501 `ApiRequestError` on a server without Discord sync. */
  async getDiscordLink(): Promise<ChatDiscordLink> {
    return normalizeChatDiscordLink(await this.options.request<unknown>("/chat/discord/link"));
  }

  async unlinkDiscord(): Promise<void> {
    await this.options.request<unknown>("/chat/discord/link", { method: "DELETE" });
  }

  /** Turns the mirroring of your own public messages to Discord on or off. */
  async setDiscordMirror(enabled: boolean): Promise<void> {
    await this.options.request<unknown>("/chat/discord/mirror", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
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
      (content, replyToId, clientMessageId, attachmentIds) =>
        this.sendMessage(channelId, content, replyToId, clientMessageId, attachmentIds),
    );
  }

  subscribeNotifications(listener: ChatNotificationListener): () => void {
    return this.options.socket.subscribeChatNotifications(listener);
  }

  subscribePresence(listener: ChatPresenceListener): () => void {
    return this.options.socket.subscribeChatPresence(listener);
  }
}
