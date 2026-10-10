import type {
  AppNotificationDelivery,
  AppNotificationRequest,
} from "../../../../types/plugin";
import { apiClient, type ChatChannel, type ChatMessage, type ChatNotification } from "../../../../api-client";
import { appendNotificationLog, markNotificationLogRead } from "../../../../notifications/notification-log";
import type { ChannelRuntimeState, MergeMessagesOptions } from "./state";
import { formatChatPaneTitle } from "../channel-labels";
import {
  formatChannelToast,
  formatMentionToast,
  formatReplyToast,
} from "./utils";

function wasNotificationDelivered(delivery: AppNotificationDelivery | void): boolean {
  return !!delivery && (delivery.toastVisible || delivery.desktopRequested);
}

function notifyChatServerMessage({
  notification,
  channel,
  notifiedMessageIds,
  notify,
  openMessage,
}: {
  notification: ChatNotification;
  channel: ChatChannel | undefined;
  notifiedMessageIds: Set<string>;
  notify: (notification: AppNotificationRequest) => AppNotificationDelivery | void;
  openMessage?: (channelId: string, messageId: string) => void;
}): boolean {
  if (notifiedMessageIds.has(notification.messageId)) return true;
  const channelTitle = formatChatPaneTitle(channel, notification.channelId);
  const body = notification.type === "reply"
    ? formatReplyToast(notification.message)
    : notification.type === "mention"
      ? formatMentionToast(notification.message)
      : formatChannelToast(notification.message, channel?.kind === "direct");
  const delivered = wasNotificationDelivered(notify({
    title: channelTitle,
    body,
    type: "info",
    source: "chat",
    desktop: "when-inactive",
    refId: notification.messageId,
    ...(openMessage ? {
      action: {
        label: "Open",
        onClick: () => openMessage(notification.channelId, notification.messageId),
      },
    } : {}),
  }));
  if (delivered) {
    notifiedMessageIds.add(notification.messageId);
  }
  return delivered;
}

export function handleChatNotification({
  notification,
  options = {},
  ensureChannelState,
  mergeMessages,
  appActive,
  getChannel,
  notifiedMessageIds,
  notify,
  openMessage,
}: {
  notification: ChatNotification;
  options?: { countUnread?: boolean };
  ensureChannelState: (channelId: string) => ChannelRuntimeState;
  mergeMessages: (channelId: string, messages: ChatMessage[], options?: MergeMessagesOptions) => void;
  appActive: boolean;
  getChannel: (channelId: string) => ChatChannel | undefined;
  notifiedMessageIds: Set<string>;
  notify: (notification: AppNotificationRequest) => AppNotificationDelivery | void;
  openMessage?: (channelId: string, messageId: string) => void;
}): void {
  mergeMessages(notification.channelId, [notification.message], { countUnread: options.countUnread });
  const channel = ensureChannelState(notification.channelId);
  const activelyViewed = appActive && channel.focusedViewCount > 0;
  const delivered = activelyViewed || notifyChatServerMessage({
    notification,
    channel: getChannel(notification.channelId),
    notifiedMessageIds,
    notify,
    openMessage,
  });
  if (activelyViewed) {
    notifiedMessageIds.add(notification.messageId);
    // A team channel that is already open marks the message read immediately.
    // Keep it in the log anyway, or team history only has messages that arrived
    // while the channel was closed.
    if (notification.channelId.startsWith("team:")) {
      const entry = appendNotificationLog({
        title: formatChatPaneTitle(getChannel(notification.channelId), notification.channelId),
        body: notification.type === "reply"
          ? formatReplyToast(notification.message)
          : notification.type === "mention"
            ? formatMentionToast(notification.message)
            : formatChannelToast(notification.message, false),
        type: "info",
        refId: notification.messageId,
      }, "team");
      markNotificationLogRead([entry.id]);
    }
  }
  if (delivered) {
    void apiClient.markChatNotificationsDelivered([notification.id]).catch(() => {});
  }
}
