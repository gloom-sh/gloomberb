import type {
  AppNotificationDelivery,
  AppNotificationRequest,
} from "../../../../types/plugin";
import { apiClient, type ChatChannel, type ChatMessage, type ChatNotification } from "../../../../api-client";
import type { ChannelRuntimeState, MergeMessagesOptions } from "./state";
import { formatChatPaneTitle } from "../channel-labels";
import {
  formatChannelToast,
  formatMentionToast,
  formatReplyToast,
} from "./utils";

/**
 * How long an app in the background holds a chat banner. The reader may be
 * reading the message at that moment on another device or in a popped-out
 * window, which tells the server within a second; the banner goes up only if
 * the server still has the message unseen.
 */
const BACKGROUND_ALERT_DELAY_MS = 2_000;

type Notify = (notification: AppNotificationRequest) => AppNotificationDelivery | void;

interface ChatNotificationAlertsOptions {
  getAppActive: () => boolean;
  ensureChannelState: (channelId: string) => ChannelRuntimeState;
  mergeMessages: (channelId: string, messages: ChatMessage[], options?: MergeMessagesOptions) => void;
  getChannel: (channelId: string) => ChatChannel | undefined;
  getNotify: () => Notify;
  getOpenMessage: () => ((channelId: string, messageId: string) => void) | undefined;
}

/** Whether this window holds the message as read: its read marker is at or after it. */
function isReadHere(channel: ChannelRuntimeState, messageId: string): boolean {
  const viewedId = channel.lastViewedMessageId;
  if (!viewedId) return false;
  if (viewedId === messageId) return true;
  const viewedIndex = channel.messages.findIndex((message) => message.id === viewedId);
  if (viewedIndex < 0) return false;
  const messageIndex = channel.messages.findIndex((message) => message.id === messageId);
  return messageIndex >= 0 && messageIndex <= viewedIndex;
}

/**
 * Tells the server how a notification reached the reader. `seen`: where they
 * were looking (the open channel, a toast in the foreground), which also
 * stops the phone push waiting on it. Without it, only a banner on a
 * computer nobody may be at, which still stops the email and the reminder on
 * the next reconnect.
 */
function acknowledge(notification: ChatNotification, seen: boolean): void {
  void apiClient.markChatNotificationsDelivered([notification.id], { seen }).catch(() => {});
}

/**
 * Decides, once per message, whether a chat notification becomes a toast or
 * a desktop banner. A message already read here or on another device stays
 * quiet, whether it arrives live or again on reconnect.
 */
export class ChatNotificationAlerts {
  private readonly notifiedMessageIds = new Set<string>();
  private readonly waiting = new Map<string, ReturnType<typeof setTimeout>>();
  private generation = 0;
  /** False in a popped-out window: the main window raises the background banners. */
  raisesBackgroundAlerts = true;
  backgroundDelayMs = BACKGROUND_ALERT_DELAY_MS;

  constructor(private readonly options: ChatNotificationAlertsOptions) {}

  handle(notification: ChatNotification, options: { countUnread?: boolean } = {}): void {
    this.options.mergeMessages(notification.channelId, [notification.message], { countUnread: options.countUnread });
    if (this.notifiedMessageIds.has(notification.messageId)) {
      // Shown here already; this copy came back on a reconnect.
      acknowledge(notification, false);
      return;
    }
    if (this.waiting.has(notification.id) || this.settledHere(notification)) return;

    if (this.options.getAppActive()) {
      this.present(notification);
      return;
    }
    if (!this.raisesBackgroundAlerts) return;
    const generation = this.generation;
    this.waiting.set(notification.id, setTimeout(() => {
      this.waiting.delete(notification.id);
      void this.presentIfUnseen(notification, generation);
    }, this.backgroundDelayMs));
  }

  /** Drops what is waiting and what was shown, as on sign-out. */
  clear(): void {
    this.generation += 1;
    for (const timer of this.waiting.values()) clearTimeout(timer);
    this.waiting.clear();
    this.notifiedMessageIds.clear();
  }

  /** Read here, or open in front of the reader: nothing to raise, and the server hears it was seen. */
  private settledHere(notification: ChatNotification): boolean {
    const channel = this.options.ensureChannelState(notification.channelId);
    const viewing = this.options.getAppActive() && channel.focusedViewCount > 0;
    if (!viewing && !isReadHere(channel, notification.messageId)) return false;
    this.notifiedMessageIds.add(notification.messageId);
    acknowledge(notification, true);
    return true;
  }

  private async presentIfUnseen(notification: ChatNotification, generation: number): Promise<void> {
    let unseen = true;
    try {
      const ids = await apiClient.getUnseenChatNotificationIds([notification.id]);
      unseen = ids.includes(notification.id);
    } catch {
      // A server that cannot say (an older one, a dropped request) gets the banner, as before.
    }
    if (generation !== this.generation || this.notifiedMessageIds.has(notification.messageId)) return;
    if (!unseen) {
      // Read, or shown in front of the reader, on another device or window.
      this.notifiedMessageIds.add(notification.messageId);
      return;
    }
    if (this.settledHere(notification)) return;
    this.present(notification);
  }

  private present(notification: ChatNotification): void {
    const channel = this.options.getChannel(notification.channelId);
    const body = notification.type === "reply"
      ? formatReplyToast(notification.message)
      : notification.type === "mention"
        ? formatMentionToast(notification.message)
        : formatChannelToast(notification.message, channel?.kind === "direct");
    const openMessage = this.options.getOpenMessage();
    const delivery = this.options.getNotify()({
      title: formatChatPaneTitle(channel, notification.channelId),
      body,
      type: "info",
      desktop: "when-inactive",
      ...(openMessage ? {
        action: {
          label: "Open",
          onClick: () => openMessage(notification.channelId, notification.messageId),
        },
      } : {}),
    });
    const toastVisible = !!delivery && delivery.toastVisible;
    // Nothing reached the reader: it stays pending for the email and the next reconnect.
    if (!toastVisible && !(delivery && delivery.desktopRequested)) return;
    this.notifiedMessageIds.add(notification.messageId);
    acknowledge(notification, toastVisible);
  }
}
