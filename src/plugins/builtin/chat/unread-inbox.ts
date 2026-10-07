import type { ChatChannel, ChatMessage } from "../../../api-client";
import { formatChatPaneTitle } from "./channel-labels";
import { chatMessageMentionsUsername, normalizeChatUsername } from "./controller/utils";

export const UNREAD_INBOX_PANE_ID = "unread-inbox";
export const UNREAD_INBOX_TEMPLATE_ID = "unread-inbox-pane";

export interface UnreadInboxChannelState {
  channelId: string;
  /** The account's unread count for the channel, as Gloom Cloud keeps it. */
  unreadCount: number;
  /** The read marker: the last message read in the channel. */
  lastViewedMessageId: string | null;
  /** The channel's messages on this device, oldest first. */
  messages: ChatMessage[];
}

export interface UnreadInboxItem {
  channelId: string;
  title: string;
  unreadCount: number;
  /**
   * The newest message known to be unread, a mention of you first. Null when
   * the messages after the read marker are not on this device: the count is
   * still right, but which messages it counts is not known here.
   */
  preview: ChatMessage | null;
  mentionsYou: boolean;
}

/**
 * Cached messages after the read marker are unread for certain. Without the
 * marker in the cache nothing can be placed before or after it, so no message
 * is claimed as unread (the cache may be older than what was read elsewhere).
 */
function knownUnreadMessages(
  state: UnreadInboxChannelState,
  userId: string | null,
): ChatMessage[] {
  if (!state.lastViewedMessageId) return [];
  const markerIndex = state.messages.findIndex((message) => message.id === state.lastViewedMessageId);
  if (markerIndex < 0) return [];
  return state.messages
    .slice(markerIndex + 1)
    .filter((message) => message.user.id !== userId && !message.clientStatus);
}

function messageTime(message: ChatMessage | undefined): number {
  const time = message ? Date.parse(message.createdAt) : Number.NaN;
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/**
 * One row per channel with unread messages, the newest known unread message
 * first; rows whose messages are not known here follow, most unread first.
 * Listing them reads nothing.
 */
export function listUnreadInboxItems(options: {
  channels: ChatChannel[];
  states: UnreadInboxChannelState[];
  user: { id: string; username: string } | null;
}): UnreadInboxItem[] {
  if (!options.user) return [];
  const userId = options.user.id;
  const username = normalizeChatUsername(options.user.username);
  const channelById = new Map(options.channels.map((channel) => [channel.id, channel]));
  const items: Array<UnreadInboxItem & { latestAt: number }> = [];
  for (const state of options.states) {
    const channel = channelById.get(state.channelId);
    if (!channel || state.unreadCount <= 0) continue;
    const unread = knownUnreadMessages(state, userId);
    const mention = username
      ? unread.findLast((message) => chatMessageMentionsUsername(message.content, username)) ?? null
      : null;
    items.push({
      channelId: channel.id,
      title: formatChatPaneTitle(channel, channel.id),
      unreadCount: state.unreadCount,
      preview: mention ?? unread.at(-1) ?? null,
      mentionsYou: !!mention,
      latestAt: messageTime(unread.at(-1)),
    });
  }
  return items
    .sort((left, right) => (
      right.latestAt - left.latestAt
      || right.unreadCount - left.unreadCount
      || left.title.localeCompare(right.title)
    ))
    .map(({ latestAt: _latestAt, ...item }) => item);
}
