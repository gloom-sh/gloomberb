import type { NotificationLogEntry } from "./notification-log";

export interface NotificationChatUnread {
  unreadCount: number;
  unreadMessageIds: ReadonlySet<string>;
}

const EMPTY_CHAT_UNREAD: NotificationChatUnread = {
  unreadCount: 0,
  unreadMessageIds: new Set(),
};

/** Chat unread and log `read` are separate, so rows that still account for the badge stay unread. */
export function notificationIdsThatAppearUnread(
  entries: readonly NotificationLogEntry[],
  chat: NotificationChatUnread = EMPTY_CHAT_UNREAD,
): Set<string> {
  const ids = new Set<string>();
  let matchedChat = 0;
  for (const entry of entries) {
    const chatMatch = !!entry.refId && chat.unreadMessageIds.has(entry.refId);
    if (!entry.read || chatMatch) {
      ids.add(entry.id);
      if (chatMatch) matchedChat += 1;
    }
  }
  const unmatched = Math.max(0, chat.unreadCount - matchedChat);
  if (unmatched === 0) return ids;
  const candidates = entries
    .filter((entry) => !!entry.refId && !ids.has(entry.id))
    .sort((left, right) => right.at - left.at);
  for (const entry of candidates.slice(0, unmatched)) ids.add(entry.id);
  return ids;
}
