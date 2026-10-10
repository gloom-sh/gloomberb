import { describe, expect, test } from "bun:test";
import { notificationIdsThatAppearUnread } from "./unread-appearance";
import type { NotificationLogEntry } from "./notification-log";

function entry(patch: Partial<NotificationLogEntry> & Pick<NotificationLogEntry, "id">): NotificationLogEntry {
  return {
    body: patch.body ?? patch.id,
    type: "info",
    source: patch.source ?? "chat",
    at: patch.at ?? 1,
    read: patch.read ?? true,
    ...patch,
  };
}

describe("notificationIdsThatAppearUnread", () => {
  test("keeps a read chat row unread while that message still counts toward the badge", () => {
    const rows = [
      entry({ id: "old", refId: "m-old", at: 1, read: true }),
      entry({ id: "live", refId: "m-live", at: 2, read: true }),
    ];
    const unread = notificationIdsThatAppearUnread(rows, {
      unreadCount: 1,
      unreadMessageIds: new Set(["m-live"]),
    });
    expect([...unread]).toEqual(["live"]);
  });

  test("attributes unmatched channel unread to the newest chat rows", () => {
    const rows = [
      entry({ id: "alert", source: "alerts", refId: undefined, at: 3, read: true }),
      entry({ id: "older", refId: "m1", at: 1, read: true }),
      entry({ id: "newer", refId: "m2", at: 2, read: true }),
    ];
    const unread = notificationIdsThatAppearUnread(rows, {
      unreadCount: 1,
      unreadMessageIds: new Set(),
    });
    expect(unread.has("newer")).toBe(true);
    expect(unread.has("older")).toBe(false);
    expect(unread.has("alert")).toBe(false);
  });

  test("still treats an unread non-chat log row as unread when chat is clear", () => {
    const rows = [entry({ id: "alert", source: "alerts", at: 1, read: false })];
    expect(notificationIdsThatAppearUnread(rows).has("alert")).toBe(true);
  });
});
