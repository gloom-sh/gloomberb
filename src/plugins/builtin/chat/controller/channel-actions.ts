import type { AppNotificationRequest } from "../../../../types/plugin";
import {
  apiClient,
  type ChatChannelState,
} from "../../../../api-client";
import type { ChannelRuntimeState } from "./state";
import { createClientMessageId } from "./utils";

export function updateChatChannelDraft(
  channel: ChannelRuntimeState,
  draft: string,
): boolean {
  if (draft === channel.draft) return false;

  const previousDraft = channel.draft;
  channel.draft = draft;
  if (!draft.trim()) {
    channel.draftClientMessageId = null;
  } else if (!previousDraft.trim() || !channel.draftClientMessageId) {
    channel.draftClientMessageId = createClientMessageId();
  }
  return true;
}

export function updateChatChannelNotifications({
  channelId,
  channel,
  enabled,
  applyChannelState,
  ensureOpenChannelConnections,
  emit,
  notify,
}: {
  channelId: string;
  channel: ChannelRuntimeState;
  enabled: boolean;
  applyChannelState: (state: ChatChannelState) => void;
  ensureOpenChannelConnections: () => void;
  emit: () => void;
  notify: (notification: AppNotificationRequest) => void;
}): void {
  if (channel.notificationsEnabled === enabled) return;

  const previous = channel.notificationsEnabled;
  channel.notificationsEnabled = enabled;
  emit();
  ensureOpenChannelConnections();

  void apiClient.updateChatChannelState(channelId, {
    notificationsEnabled: enabled,
  }).then((nextState) => {
    applyChannelState(nextState);
    ensureOpenChannelConnections();
    emit();
  }).catch((error) => {
    channel.notificationsEnabled = previous;
    ensureOpenChannelConnections();
    emit();
    notify({
      body: error instanceof Error ? error.message : "Failed to update channel notifications.",
      type: "error",
    });
  });
}

export function attachChatChannelView({
  channel,
  channelId,
  emit,
  flushDraftSync,
  focused,
  appActive,
  markViewedThroughLatestMessage,
}: {
  channel: ChannelRuntimeState;
  channelId: string;
  emit: (channelId: string) => void;
  flushDraftSync: (channelId: string) => void;
  focused: boolean;
  appActive: boolean;
  markViewedThroughLatestMessage: (channelId: string) => boolean;
}): () => void {
  channel.openViewCount += 1;
  if (focused) {
    channel.focusedViewCount += 1;
  }
  if (focused && appActive && markViewedThroughLatestMessage(channelId)) {
    emit(channelId);
  }
  return () => {
    channel.openViewCount = Math.max(0, channel.openViewCount - 1);
    if (focused) {
      channel.focusedViewCount = Math.max(0, channel.focusedViewCount - 1);
    }
    flushDraftSync(channelId);
  };
}
