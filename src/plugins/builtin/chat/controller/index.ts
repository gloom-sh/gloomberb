import type {
  AppNotificationDelivery,
  AppNotificationRequest,
  PluginPersistence,
  PluginResumeState,
} from "../../../../types/plugin";
import {
  apiClient,
  type ChatAttachmentUpload,
  type ChatChannel,
  type ChatChannelState,
  type ChatMessage,
  type PersistedAuthUser,
} from "../../../../api-client";
import { normalizeSessionUser } from "./persistence";
import { debugLog } from "../../../../utils/debug-log";
import {
  getUnreadMentionMessages,
  getVisibleMessages,
  markChatChannelViewedThroughLatestMessage,
  mergeChatMessages,
} from "./messages";
import {
  DEFAULT_CHAT_CHANNEL_ID,
  normalizeChannelId,
  type ChannelRuntimeState,
  type ChatControllerSnapshot,
  type MergeMessagesOptions,
} from "./state";
import {
  attachChatChannelView,
  updateChatChannelDraft,
  updateChatChannelNotifications,
} from "./channel-actions";
import { retryChatMessageInChannel, sendChatMessageToChannel } from "./send";
import {
  addDraftAttachments,
  discardDraftAttachments,
  retryDraftAttachment,
  type ChatAttachmentUploader,
} from "./attachments";
import {
  clearChatControllerSessionState,
  disposeChatControllerRuntime,
  resetChatControllerRuntime,
} from "./lifecycle";
import {
  closeAllChannelConnections,
  closeInactiveChannelConnections,
  countOpenConnections,
  ensureChatChannelConnection,
  getOpenConnectionChannelIds,
  getSafetyRefreshChannelIds as getChannelIdsForSafetyRefresh,
} from "./connections";
import {
  handleChatNotification as handleChatNotificationEvent,
} from "./notifications";
import {
  CHAT_MESSAGE_EDIT_WINDOW_LABEL,
  DISCORD_MESSAGE_EDIT_NOTICE,
  isEditableOnGloom,
  isWithinChatMessageEditWindow,
} from "../edit-window";
import { ChatControllerRealtime } from "./realtime";
import { ChatControllerChannels } from "./channels";
import { ChatControllerView } from "./view";
import { ChatControllerMessageLoading } from "./message-loading";
import { ChatControllerStorage } from "./storage";
import { listUnreadInboxItems } from "../unread-inbox";
import type { ChatConversationList } from "../conversations";
import {
  applySignedOutChatControllerSession,
  createChatControllerSessionState,
  hydrateChatControllerSession,
  refreshChatControllerSession,
} from "./session-runtime";

const chatLog = debugLog.createLogger("chat-controller");
const IMAGE_LINK_REFRESH_INTERVAL_MS = 60_000;

function timeOf(value: string | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/**
 * The newest message held for a conversation, sent or received. A DM or group
 * with nothing on this device yet counts from when it was started.
 */
function lastConversationActivity(channel: ChatChannel, state: ChannelRuntimeState | undefined): number {
  const started = channel.kind === "direct" || channel.kind === "group"
    ? timeOf(channel.created_at)
    : Number.NEGATIVE_INFINITY;
  return Math.max(
    started,
    timeOf(state?.messages.at(-1)?.createdAt),
    timeOf(state?.pendingMessages.at(-1)?.createdAt),
  );
}

export type { ChatControllerSnapshot } from "./state";

export class ChatController {
  private appActive = true;
  private readonly session = createChatControllerSessionState();
  private pendingMessageSeq = 0;
  private draftAttachmentSeq = 0;
  /** How images go up; a test can stand in for the server here. */
  uploadAttachment: ChatAttachmentUploader = (channelId, upload, options) => (
    apiClient.uploadChatAttachment(channelId, upload, options)
  );
  private notifyFn: (notification: AppNotificationRequest) => AppNotificationDelivery | void = () => {};
  private openMessageFn: ((channelId: string, messageId: string) => void) | undefined;
  private notifiedMessageIds = new Set<string>();

  private readonly storage = new ChatControllerStorage({
    emit: (channelId) => this.emit(channelId),
    getUser: () => this.session.user,
  });
  private readonly channelCatalog = new ChatControllerChannels({
    canLoadPrivateState: () => !!this.session.user?.emailVerified,
    ensureChannelState: (channelId) => this.ensureChannelState(channelId),
    getChannelStateIds: () => this.storage.channelStates.keys(),
    handleNotification: (notification, options) => this.handleChatNotification(notification, options),
    ensureOpenChannelConnections: () => this.ensureOpenChannelConnections(),
    emit: (channelId) => this.emit(channelId),
  });
  private readonly view = new ChatControllerView({
    ensureChannelState: (channelId) => this.ensureChannelState(channelId),
    getChannels: () => this.channelCatalog.getChannels(),
    getChannelStateSnapshots: () => this.channelCatalog.getChannelStateSnapshots(),
    isChannelsLoading: () => this.channelCatalog.isLoading(),
    isSessionChecked: () => this.session.sessionChecked,
    hasSession: () => !!this.session.sessionToken || !!this.session.user,
    getOnlineCount: () => this.channelCatalog.getOnlineCount(),
    getUser: () => this.session.user,
    getListenerSnapshot: (channelId) => this.getSnapshot(channelId),
    getVisibleMessages: (channelId) => this.getVisibleMessages(channelId),
    getUnreadMentionCount: (channelId) => this.getUnreadMentionCount(channelId),
  });
  private readonly messageLoading = new ChatControllerMessageLoading({
    ensureChannelState: (channelId) => this.ensureChannelState(channelId),
    emit: (channelId) => this.emit(channelId),
    mergeMessages: (channelId, messages, options) => this.mergeMessages(channelId, messages, options),
    persistChannelState: (channelId) => this.storage.persistChannelState(channelId),
  });
  private readonly realtime = new ChatControllerRealtime({
    getAppActive: () => this.appActive,
    hasSession: () => !!this.session.sessionToken || !!this.session.user,
    getUser: () => this.session.user,
    refreshSession: () => this.refreshSession(),
    handleNotification: (notification) => this.handleChatNotification(notification),
    setOnlineCount: (onlineCount) => {
      this.channelCatalog.setOnlineCount(onlineCount);
    },
    emit: () => this.emit(),
    getSafetyRefreshChannelIds: () => getChannelIdsForSafetyRefresh(this.storage.channelStates),
    runSafetyRefresh: (channelId) => this.messageLoading.runMessagesRefresh(channelId, { showLoading: false }),
  });

  attachPersistence(persistence: PluginPersistence, resume?: PluginResumeState): void {
    this.storage.attachPersistence(persistence, resume);
    this.hydrate();
  }

  setNotifier(
    notify: (notification: AppNotificationRequest) => AppNotificationDelivery | void,
    openMessage?: (channelId: string, messageId: string) => void,
  ): void {
    this.notifyFn = notify;
    this.openMessageFn = openMessage;
  }

  hydrate(): void {
    hydrateChatControllerSession({
      session: this.session,
      storage: this.storage,
      syncVerificationPolling: () => this.realtime.syncVerificationPolling(),
    });
  }

  subscribe(listener: (snapshot: ChatControllerSnapshot) => void): () => void;
  subscribe(channelId: string, listener: (snapshot: ChatControllerSnapshot) => void): () => void;
  subscribe(
    channelIdOrListener: string | ((snapshot: ChatControllerSnapshot) => void),
    maybeListener?: (snapshot: ChatControllerSnapshot) => void,
  ): () => void {
    if (typeof channelIdOrListener === "function") {
      return this.view.subscribe(channelIdOrListener);
    }
    return this.view.subscribe(channelIdOrListener, maybeListener as (snapshot: ChatControllerSnapshot) => void);
  }

  getSnapshot(channelId = DEFAULT_CHAT_CHANNEL_ID): ChatControllerSnapshot {
    return this.view.getSnapshot(channelId);
  }

  /** Channels with unread messages, from the counts and messages already held; no request. */
  listUnreadInbox() {
    return listUnreadInboxItems({
      channels: this.channelCatalog.getChannels(),
      user: this.session.user,
      states: [...this.storage.channelStates.entries()].map(([channelId, channel]) => ({
        channelId,
        unreadCount: channel.unreadCount,
        lastViewedMessageId: channel.lastViewedMessageId,
        messages: channel.messages,
      })),
    });
  }

  /**
   * Every conversation the Chat sidebar lists, with its unread count and last
   * activity, from what this device already holds; no request. Null until a
   * verified account is signed in.
   */
  listConversations(): ChatConversationList | null {
    const user = this.session.user;
    if (!user?.emailVerified) return null;
    return {
      userId: user.id,
      states: this.channelCatalog.getChannels().map((channel) => {
        const state = this.storage.channelStates.get(channel.id);
        return {
          channel,
          unreadCount: Math.max(0, state?.unreadCount ?? 0),
          lastActivityAt: lastConversationActivity(channel, state),
        };
      }),
    };
  }

  getChannels(): ChatChannel[] {
    return this.channelCatalog.getChannels();
  }

  async refreshChannels(): Promise<void> {
    return this.channelCatalog.refreshChannels();
  }

  async refreshPresence(): Promise<void> {
    return this.channelCatalog.refreshPresence();
  }

  async refreshChatState(): Promise<void> {
    return this.channelCatalog.refreshChatState();
  }

  async openDirectChannel(target: { userId?: string; username?: string }): Promise<ChatChannel> {
    return this.channelCatalog.openDirectChannel(target);
  }

  async openGroupChannel(body: { userIds?: string[]; usernames?: string[]; name?: string }): Promise<ChatChannel> {
    return this.channelCatalog.openGroupChannel(body);
  }

  async resolveRequiredChannelId(channelId: string): Promise<string> {
    return this.channelCatalog.resolveRequiredChannelId(channelId);
  }

  async resolvePreferredChannelId(channelId: string | null | undefined): Promise<string> {
    return this.channelCatalog.resolvePreferredChannelId(channelId);
  }

  private ensureChannelState(channelId: string): ChannelRuntimeState {
    return this.storage.ensureChannelState(channelId);
  }

  /** Single-flight: every open chat pane calls this on mount. */
  async refreshSession(): Promise<void> {
    if (this.sessionRefreshPromise) return this.sessionRefreshPromise;
    this.realtime.stopSessionRetry();
    const generation = this.sessionRefreshGeneration;
    const isCurrent = () => generation === this.sessionRefreshGeneration;
    const request = this.runSessionRefresh(isCurrent)
      .catch((error) => {
        if (isCurrent()) this.realtime.scheduleSessionRetry();
        throw error;
      })
      .finally(() => {
        if (this.sessionRefreshPromise === request) this.sessionRefreshPromise = null;
      });
    this.sessionRefreshPromise = request;
    return request;
  }

  private sessionRefreshPromise: Promise<void> | null = null;
  private sessionRefreshGeneration = 0;

  private invalidateSessionRefresh(): void {
    this.sessionRefreshGeneration += 1;
    this.sessionRefreshPromise = null;
  }

  private async runSessionRefresh(isCurrent: () => boolean): Promise<void> {
    return refreshChatControllerSession({
      isCurrent,
      applySignedOut: () => this.applySignedOutSession(),
      channelStates: this.storage.channelStates,
      emit: () => this.emit(),
      ensureOpenChannelConnections: () => this.ensureOpenChannelConnections(),
      ensureRealtimeSubscriptions: () => this.realtime.ensureRealtimeSubscriptions(),
      persistChannelState: (channelId) => this.storage.persistChannelState(channelId),
      persistSession: (sessionToken, user) => this.storage.persistSession(sessionToken, user),
      refreshChatState: (isCurrent) => this.channelCatalog.refreshChatState(isCurrent),
      scheduleSessionRetry: () => this.realtime.scheduleSessionRetry(),
      session: this.session,
      stopRealtimeSubscriptions: () => {
        this.realtime.stopRealtimeSubscriptions();
        this.closeAllConnections();
      },
      stopSafetyRefresh: () => this.realtime.stopSafetyRefresh(),
      stopVerificationPolling: () => this.realtime.stopVerificationPolling(),
      syncVerificationPolling: () => this.realtime.syncVerificationPolling(),
    });
  }

  async refreshMessages(): Promise<void> {
    return this.messageLoading.refreshMessages();
  }

  async refreshChannelMessages(channelId: string): Promise<void> {
    return this.messageLoading.refreshChannelMessages(channelId);
  }

  /**
   * Fetches the latest page again in full after an image failed to load.
   * Private images come with links signed for an hour or two, and a fresh
   * copy of the message carries a fresh link. At most once a minute a channel.
   */
  refreshChannelImageLinks(channelId: string): void {
    const normalizedChannelId = normalizeChannelId(channelId);
    const now = Date.now();
    if (now - (this.imageLinkRefreshAt.get(normalizedChannelId) ?? 0) < IMAGE_LINK_REFRESH_INTERVAL_MS) return;
    this.imageLinkRefreshAt.set(normalizedChannelId, now);
    const channel = this.ensureChannelState(normalizedChannelId);
    channel.backfilled = false;
    void this.messageLoading.runMessagesRefresh(normalizedChannelId, { showLoading: false }).catch(() => {});
  }

  private readonly imageLinkRefreshAt = new Map<string, number>();

  async loadOlderMessages(): Promise<void> {
    return this.messageLoading.loadOlderMessages();
  }

  async loadOlderChannelMessages(channelId: string): Promise<void> {
    return this.messageLoading.loadOlderChannelMessages(channelId);
  }

  setDraft(draft: string): void {
    this.setChannelDraft(DEFAULT_CHAT_CHANNEL_ID, draft);
  }

  setChannelDraft(channelId: string, draft: string): void {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.ensureChannelState(normalizedChannelId);
    if (updateChatChannelDraft(channel, draft)) {
      this.storage.scheduleDraftSync(normalizedChannelId);
    }
  }

  setReplyToId(replyToId: string | null): void {
    this.setChannelReplyToId(DEFAULT_CHAT_CHANNEL_ID, replyToId);
  }

  setChannelReplyToId(channelId: string, replyToId: string | null): void {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.ensureChannelState(normalizedChannelId);
    channel.replyToId = replyToId;
    this.storage.persistChannelState(normalizedChannelId);
    this.emit(normalizedChannelId);
  }

  setChannelNotificationsEnabled(channelId: string, enabled: boolean): void {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.ensureChannelState(normalizedChannelId);
    updateChatChannelNotifications({
      channelId: normalizedChannelId,
      channel,
      enabled,
      applyChannelState: (state) => this.applyChannelState(state),
      ensureOpenChannelConnections: () => this.ensureOpenChannelConnections(),
      emit: () => this.emit(),
      notify: this.notifyFn,
    });
  }

  attachView(focused = true): () => void {
    return this.attachChannelView(DEFAULT_CHAT_CHANNEL_ID, focused);
  }

  attachChannelView(channelId: string, focused = true): () => void {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.ensureChannelState(normalizedChannelId);
    return attachChatChannelView({
      channel,
      channelId: normalizedChannelId,
      emit: (nextChannelId) => this.emit(nextChannelId),
      flushDraftSync: (nextChannelId) => this.storage.flushDraftSync(nextChannelId),
      focused,
      appActive: this.appActive,
      markViewedThroughLatestMessage: (nextChannelId) => this.markViewedThroughLatestMessage(nextChannelId),
    });
  }

  /**
   * Installs a session obtained outside the cookie-capturing transport (device
   * sign-in hands over a raw token in the response body) the same way boot
   * restoration does, then persists it through the normal session persistence
   * so a restart stays signed in even if a follow-up refresh cannot reach the
   * server. Callers should still refreshSession() afterwards to validate and
   * pick up the full profile.
   */
  adoptSession(sessionToken: string, user: PersistedAuthUser): void {
    this.invalidateSessionRefresh();
    apiClient.setSessionToken(sessionToken);
    apiClient.setWebSocketToken(null);
    apiClient.restoreCachedUser(user);
    this.session.sessionToken = sessionToken;
    this.session.user = normalizeSessionUser(user);
    this.session.sessionChecked = true;
    this.storage.persistSession(this.session.sessionToken, this.session.user);
    this.emit();
  }

  clearSession(): void {
    this.invalidateSessionRefresh();
    clearChatControllerSessionState({
      channelStates: this.storage.channelStates.values(),
      clearSessionIdentity: () => {
        this.session.sessionToken = null;
        this.session.user = null;
        this.session.sessionChecked = false;
      },
      closeAllConnections: () => this.closeAllConnections(),
      emit: () => this.emit(),
      stopRealtime: () => this.realtime.stopAll(),
    });
  }

  setAppActive(appActive: boolean): void {
    if (this.appActive === appActive) return;
    this.appActive = appActive;
    if (!appActive) {
      this.realtime.stopVerificationPolling();
      this.realtime.stopSessionRetry();
      return;
    }
    this.markFocusedViewsViewed();
    this.realtime.syncVerificationPolling();
    void this.refreshSession()
      .then(() => this.markFocusedViewsViewed())
      .catch(() => {});
  }

  reset(clearSession = false): void {
    this.invalidateSessionRefresh();
    resetChatControllerRuntime({
      channelStates: this.storage.channelStates,
      clearApiSessionToken: () => apiClient.setSessionToken(null),
      clearDraftSyncTimer: (channel) => this.storage.clearDraftSyncTimer(channel),
      clearSessionIdentity: () => {
        this.session.sessionToken = null;
        this.session.user = null;
      },
      closeAllConnections: () => this.closeAllConnections(),
      deleteSession: () => this.storage.deleteSession(),
      deleteTranscript: (channelId) => this.storage.deleteTranscript(channelId),
      emit: () => this.emit(),
      persistChannelState: (channelId) => this.storage.persistChannelState(channelId),
      persistSession: () => this.storage.persistSession(this.session.sessionToken, this.session.user),
      shouldClearSession: clearSession,
      stopRealtime: () => this.realtime.stopAll(),
    });
  }

  dispose(): void {
    this.invalidateSessionRefresh();
    chatLog.info("dispose controller", {
      listeners: this.view.listenerCount,
      connections: countOpenConnections(this.storage.channelStates.values()),
    });
    disposeChatControllerRuntime({
      channelStates: this.storage.channelStates,
      clearNotifications: () => this.notifiedMessageIds.clear(),
      clearView: () => this.view.clear(),
      closeAllConnections: () => this.closeAllConnections(),
      flushDraftSync: (channelId) => this.storage.flushDraftSync(channelId),
      resetNotifier: () => {
        this.notifyFn = () => {};
        this.openMessageFn = undefined;
      },
      stopRealtime: () => this.realtime.stopAll(),
    });
  }

  send(content: string, replyToId?: string): boolean {
    return this.sendToChannel(DEFAULT_CHAT_CHANNEL_ID, content, replyToId);
  }

  sendToChannel(channelId: string, content: string, replyToId?: string): boolean {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.ensureChannelState(normalizedChannelId);
    return sendChatMessageToChannel({
      channelId: normalizedChannelId,
      channel,
      content,
      replyToId,
      user: this.session.user,
      ensureConnection: () => this.ensureConnection(normalizedChannelId),
      getVisibleMessages: () => this.getVisibleMessages(normalizedChannelId),
      nextPendingMessageId: () => `local:${Date.now()}:${this.pendingMessageSeq += 1}`,
      persistChannelState: () => this.storage.persistChannelState(normalizedChannelId),
      emit: () => this.emit(normalizedChannelId),
      mergeMessages: (messages) => this.mergeMessages(normalizedChannelId, messages),
      notify: this.notifyFn,
    });
  }

  /**
   * Whether the server takes images, so the composer offers them. Until it
   * says so, chat stays text only and an older server never sees an upload.
   */
  attachmentsSupported(): boolean {
    return apiClient.chatAttachmentsSupported();
  }

  subscribeAttachmentSupport(listener: () => void): () => void {
    return apiClient.subscribeChatAttachmentSupport(listener);
  }

  /** Adds images to the channel's next message and starts uploading them; returns how many were taken. */
  attachToChannel(channelId: string, uploads: ChatAttachmentUpload[]): number {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.ensureChannelState(normalizedChannelId);
    if (!this.session.user?.emailVerified || uploads.length === 0) return 0;
    return addDraftAttachments(
      () => channel.draftAttachments,
      (entries) => { channel.draftAttachments = entries; },
      uploads,
      this.draftAttachmentDeps(normalizedChannelId),
    );
  }

  removeChannelAttachment(channelId: string, localId: string): void {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.ensureChannelState(normalizedChannelId);
    const removed = channel.draftAttachments.filter((entry) => entry.localId === localId);
    if (removed.length === 0) return;
    discardDraftAttachments(removed);
    channel.draftAttachments = channel.draftAttachments.filter((entry) => entry.localId !== localId);
    this.emit(normalizedChannelId);
  }

  retryChannelAttachment(channelId: string, localId: string): boolean {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.ensureChannelState(normalizedChannelId);
    return retryDraftAttachment(() => channel.draftAttachments, localId, this.draftAttachmentDeps(normalizedChannelId));
  }

  private draftAttachmentDeps(channelId: string) {
    return {
      channelId,
      upload: this.uploadAttachment,
      emit: () => this.emit(channelId),
      notify: (notification: AppNotificationRequest) => this.notifyFn(notification),
      nextLocalId: () => `draft-image:${this.draftAttachmentSeq += 1}`,
    };
  }

  /** Sends a failed message again with the same images and idempotency key. */
  retryChannelMessage(channelId: string, messageId: string): boolean {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.ensureChannelState(normalizedChannelId);
    if (!this.session.user?.emailVerified) return false;
    return retryChatMessageInChannel({
      channel,
      messageId,
      ensureConnection: () => this.ensureConnection(normalizedChannelId),
      emit: () => this.emit(normalizedChannelId),
      mergeMessages: (messages) => this.mergeMessages(normalizedChannelId, messages),
      notify: this.notifyFn,
    });
  }

  async editChannelMessage(channelId: string, messageId: string, content: string): Promise<boolean> {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.ensureChannelState(normalizedChannelId);
    const messageContent = content.trim();
    if (!this.session.user?.emailVerified) return false;

    const latestOwnMessage = [...getVisibleMessages(channel)]
      .reverse()
      .find((message) => (
        message.user.id === this.session.user?.id
        && !message.clientStatus
      ));
    // The images stay with an edit, so a message that has them may lose its text.
    if (!messageContent && !(latestOwnMessage?.id === messageId && latestOwnMessage.attachments?.length)) return false;
    if (!latestOwnMessage || latestOwnMessage.id !== messageId) {
      this.notifyFn({ body: "Only your latest sent message can be edited.", type: "error" });
      return false;
    }
    if (!isEditableOnGloom(latestOwnMessage)) {
      this.notifyFn({ body: DISCORD_MESSAGE_EDIT_NOTICE, type: "error" });
      return false;
    }
    if (!isWithinChatMessageEditWindow(latestOwnMessage)) {
      this.notifyFn({ body: `Messages can only be edited within ${CHAT_MESSAGE_EDIT_WINDOW_LABEL}.`, type: "error" });
      return false;
    }
    if (latestOwnMessage.content === messageContent) return true;

    try {
      const message = await apiClient.editMessage(normalizedChannelId, messageId, messageContent);
      this.mergeMessages(normalizedChannelId, [message]);
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error && error.message
        ? error.message
        : "Failed to edit message.";
      this.notifyFn({ body: errorMessage, type: "error" });
      return false;
    }
  }

  ensureConnection(channelId = DEFAULT_CHAT_CHANNEL_ID): void {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.ensureChannelState(normalizedChannelId);
    ensureChatChannelConnection({
      channelId: normalizedChannelId,
      channel,
      canConnect: !!this.session.user?.emailVerified,
      stopSafetyRefresh: () => this.realtime.stopSafetyRefresh(),
      startSafetyRefresh: () => this.realtime.startSafetyRefresh(),
      refreshMessages: () => this.refreshChannelMessages(normalizedChannelId),
      connectChannel: (nextChannelId, onMessage, onDisconnect) => (
        apiClient.connectChannel(nextChannelId, onMessage, onDisconnect)
      ),
      mergeMessages: (messages) => this.mergeMessages(normalizedChannelId, messages),
    });
  }

  private emit(channelId?: string): void {
    this.view.emit(channelId);
  }

  private applyChannelState(state: ChatChannelState): void {
    const channel = this.ensureChannelState(state.channelId);
    channel.notificationsEnabled = state.notificationsEnabled;
    channel.unreadCount = state.unreadCount;
    channel.lastViewedMessageId = state.lastReadMessageId ?? channel.lastViewedMessageId;
  }

  private closeAllConnections(): void {
    closeAllChannelConnections(this.storage.channelStates.values());
  }

  private applySignedOutSession(): void {
    applySignedOutChatControllerSession({
      channelStates: this.storage.channelStates.values(),
      closeAllConnections: () => this.closeAllConnections(),
      emit: () => this.emit(),
      persistSession: (sessionToken, user) => this.storage.persistSession(sessionToken, user),
      session: this.session,
      stopRealtime: () => this.realtime.stopAll(),
    });
  }

  private ensureOpenChannelConnections(): void {
    const channelIds = getOpenConnectionChannelIds(this.storage.channelStates);
    closeInactiveChannelConnections(this.storage.channelStates, channelIds);
    for (const channelId of channelIds) {
      this.ensureConnection(channelId);
    }
  }

  private mergeMessages(
    channelIdOrMessages: string | ChatMessage[],
    maybeMessages?: ChatMessage[] | MergeMessagesOptions,
    maybeOptions?: MergeMessagesOptions,
  ): void {
    const channelId = Array.isArray(channelIdOrMessages) ? DEFAULT_CHAT_CHANNEL_ID : channelIdOrMessages;
    const messages = Array.isArray(channelIdOrMessages)
      ? channelIdOrMessages
      : (maybeMessages as ChatMessage[] | undefined) ?? [];
    const options = Array.isArray(channelIdOrMessages)
      ? maybeMessages as MergeMessagesOptions | undefined
      : maybeOptions;
    const channel = this.ensureChannelState(channelId);
    mergeChatMessages({
      channel,
      currentUserId: this.session.user?.id,
      messages,
      options,
      viewActive: this.appActive && channel.focusedViewCount > 0,
      markViewed: (persist) => this.markViewedThroughLatestMessage(channelId, persist),
    });
    this.storage.persistTranscript(channelId);
    this.emit(channelId);
  }

  private handleChatNotification(
    notification: Parameters<typeof handleChatNotificationEvent>[0]["notification"],
    options: { countUnread?: boolean } = {},
  ): void {
    handleChatNotificationEvent({
      notification,
      options,
      appActive: this.appActive,
      ensureChannelState: (channelId) => this.ensureChannelState(channelId),
      mergeMessages: (channelId, messages, mergeOptions) => this.mergeMessages(channelId, messages, mergeOptions),
      getChannel: (channelId) => this.channelCatalog.getChannels().find((channel) => channel.id === channelId),
      notifiedMessageIds: this.notifiedMessageIds,
      notify: this.notifyFn,
      openMessage: this.openMessageFn,
    });
  }

  private getUnreadMentionCount(channelId: string): number {
    const channel = this.ensureChannelState(channelId);
    return getUnreadMentionMessages(channel, this.session.user).length;
  }

  private markFocusedViewsViewed(): void {
    for (const [channelId, channel] of this.storage.channelStates) {
      if (channel.focusedViewCount === 0) continue;
      if (this.markViewedThroughLatestMessage(channelId)) {
        this.emit(channelId);
      }
    }
  }

  private markViewedThroughLatestMessage(channelId: string, persist = true): boolean {
    const channel = this.ensureChannelState(channelId);
    return markChatChannelViewedThroughLatestMessage({
      channel,
      canSyncReadState: !!this.session.user?.emailVerified,
      persist,
      persistChannelState: () => this.storage.persistChannelState(channelId),
      syncReadState: (messageId) => {
        void apiClient.updateChatChannelState(channelId, {
          readThroughMessageId: messageId,
        }).then((state) => {
          this.applyChannelState(state);
          this.emit();
        }).catch(() => {});
      },
    });
  }

  private getVisibleMessages(channelId: string): ChatMessage[] {
    const channel = this.ensureChannelState(channelId);
    return getVisibleMessages(channel);
  }
}

export const chatController = new ChatController();
