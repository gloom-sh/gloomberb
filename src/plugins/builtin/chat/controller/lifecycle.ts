import type { ChannelRuntimeState } from "./state";
import { createClientMessageId } from "./utils";

export function clearSignedOutChannelState(channel: ChannelRuntimeState): void {
  channel.pendingMessages = [];
  channel.lastViewedMessageId = null;
  channel.unreadCount = 0;
  channel.notificationsEnabled = false;
}

function clearSessionChannelState(channel: ChannelRuntimeState): void {
  clearSignedOutChannelState(channel);
  channel.draftClientMessageId = channel.draft.trim()
    ? createClientMessageId()
    : null;
}

function resetChannelRuntimeState(channel: ChannelRuntimeState): void {
  channel.messages = [];
  channel.pendingMessages = [];
  channel.draft = "";
  channel.draftClientMessageId = null;
  channel.replyToId = null;
  channel.lastCursor = null;
  channel.lastViewedMessageId = null;
  channel.unreadCount = 0;
  channel.notificationsEnabled = false;
  channel.reachedOldestMessage = false;
  channel.openViewCount = 0;
  channel.focusedViewCount = 0;
}

function disposeChannelRuntimeState(channel: ChannelRuntimeState): void {
  channel.messagesLoading = false;
  channel.olderMessagesLoading = false;
  channel.refreshMessagesPromise = null;
  channel.loadOlderMessagesPromise = null;
  channel.openViewCount = 0;
  channel.focusedViewCount = 0;
}

interface ClearChatControllerSessionOptions {
  channelStates: Iterable<ChannelRuntimeState>;
  clearSessionIdentity: () => void;
  closeAllConnections: () => void;
  emit: () => void;
  stopRealtime: () => void;
}

export function clearChatControllerSessionState({
  channelStates,
  clearSessionIdentity,
  closeAllConnections,
  emit,
  stopRealtime,
}: ClearChatControllerSessionOptions): void {
  stopRealtime();
  closeAllConnections();
  clearSessionIdentity();
  for (const channel of channelStates) {
    clearSessionChannelState(channel);
  }
  emit();
}

interface ResetChatControllerRuntimeOptions {
  channelStates: Iterable<[string, ChannelRuntimeState]>;
  clearApiSessionToken: () => void;
  clearDraftSyncTimer: (channel: ChannelRuntimeState) => void;
  clearSessionIdentity: () => void;
  closeAllConnections: () => void;
  deleteSession: () => void;
  deleteTranscript: (channelId: string) => void;
  emit: () => void;
  persistChannelState: (channelId: string) => void;
  persistSession: () => void;
  shouldClearSession: boolean;
  stopRealtime: () => void;
}

export function resetChatControllerRuntime({
  channelStates,
  clearApiSessionToken,
  clearDraftSyncTimer,
  clearSessionIdentity,
  closeAllConnections,
  deleteSession,
  deleteTranscript,
  emit,
  persistChannelState,
  persistSession,
  shouldClearSession,
  stopRealtime,
}: ResetChatControllerRuntimeOptions): void {
  stopRealtime();
  closeAllConnections();
  for (const [channelId, channel] of channelStates) {
    clearDraftSyncTimer(channel);
    resetChannelRuntimeState(channel);
    deleteTranscript(channelId);
    persistChannelState(channelId);
  }
  if (shouldClearSession) {
    clearSessionIdentity();
    clearApiSessionToken();
    deleteSession();
  } else {
    persistSession();
  }
  emit();
}

interface DisposeChatControllerRuntimeOptions {
  channelStates: Iterable<[string, ChannelRuntimeState]>;
  clearNotifications: () => void;
  clearView: () => void;
  closeAllConnections: () => void;
  flushDraftSync: (channelId: string) => void;
  resetNotifier: () => void;
  stopRealtime: () => void;
}

export function disposeChatControllerRuntime({
  channelStates,
  clearNotifications,
  clearView,
  closeAllConnections,
  flushDraftSync,
  resetNotifier,
  stopRealtime,
}: DisposeChatControllerRuntimeOptions): void {
  for (const [channelId] of channelStates) {
    flushDraftSync(channelId);
  }
  stopRealtime();
  closeAllConnections();
  for (const [, channel] of channelStates) {
    disposeChannelRuntimeState(channel);
  }
  resetNotifier();
  clearView();
  clearNotifications();
}
