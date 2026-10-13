import { afterEach, describe, expect, test } from "bun:test";
import type { ChatChannelState } from "../../../api-client";
import {
  appendNotificationLog,
  getNotificationLog,
  markNotificationLogRead,
  resetNotificationLogForTest,
  subscribeNotificationLog,
} from "../../../notifications/notification-log";
import type { ChatControllerSnapshot } from "./controller/state";
import { unreadTotal, watchUnreadBadge } from "./unread-badge";

type Snapshot = Pick<ChatControllerSnapshot, "channelStates" | "hasSavedSession" | "user">;

function channelState(channelId: string, unreadCount: number): ChatChannelState {
  return { channelId, notificationsEnabled: false, lastReadMessageId: null, unreadCount };
}

function snapshot(unread: Record<string, number>, signedIn = true): Snapshot {
  return {
    channelStates: Object.entries(unread).map(([id, count]) => channelState(id, count)),
    hasSavedSession: signedIn,
    user: signedIn ? { id: "u-me", username: "vince", emailVerified: true } : null,
  };
}

function fakeController(initial: Snapshot) {
  const listeners = new Set<(next: Snapshot) => void>();
  return {
    subscribe(listener: (next: Snapshot) => void) {
      listeners.add(listener);
      listener(initial);
      return () => listeners.delete(listener);
    },
    emit(next: Snapshot) {
      for (const listener of listeners) listener(next);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function watch(initial: Snapshot) {
  const controller = fakeController(initial);
  const labels: string[] = [];
  const stop = watchUnreadBadge({
    controller,
    log: { get: getNotificationLog, subscribe: subscribeNotificationLog },
    setBadge: (label) => labels.push(label),
  });
  return { controller, labels, stop };
}

afterEach(() => resetNotificationLogForTest());

describe("unreadTotal", () => {
  test("counts every channel's unread messages and the notices not yet read", () => {
    const first = appendNotificationLog({ body: "NVDA above 120", refId: "price:a1" }, 1);
    appendNotificationLog({ body: "Earnings tomorrow", refId: "catalyst:c1" }, 2);
    markNotificationLogRead([first!.id]);
    expect(unreadTotal(snapshot({ everyone: 3, macro: 0, "dm:1": 2 }), getNotificationLog())).toBe(6);
  });

  test("is zero signed out, even with notices waiting", () => {
    appendNotificationLog({ body: "NVDA above 120", refId: "price:a1" }, 1);
    expect(unreadTotal(snapshot({ everyone: 3 }, false), getNotificationLog())).toBe(0);
  });
});

describe("watchUnreadBadge", () => {
  test("sets the badge once per change of the label and not while it stays the same", () => {
    const { controller, labels } = watch(snapshot({ everyone: 2 }));
    expect(labels).toEqual(["2"]);

    controller.emit(snapshot({ everyone: 2 }));
    controller.emit(snapshot({ everyone: 3 }));
    controller.emit(snapshot({ everyone: 3 }));
    expect(labels).toEqual(["2", "3"]);

    controller.emit(snapshot({ everyone: 120 }));
    controller.emit(snapshot({ everyone: 150 }));
    expect(labels).toEqual(["2", "3", "99+"]);

    controller.emit(snapshot({ everyone: 0 }));
    expect(labels).toEqual(["2", "3", "99+", ""]);
  });

  test("makes no call while the count stays at zero, not even on stop", () => {
    const { controller, labels, stop } = watch(snapshot({ everyone: 0 }));
    controller.emit(snapshot({ everyone: 0, macro: 0 }));
    stop();
    expect(labels).toEqual([]);
  });

  test("follows the missed notices as they arrive and are read", () => {
    const { labels } = watch(snapshot({ everyone: 1 }));
    appendNotificationLog({ body: "NVDA above 120", refId: "price:a1" }, 1);
    appendNotificationLog({ body: "Earnings tomorrow", refId: "catalyst:c1" }, 2);
    markNotificationLogRead();
    expect(labels).toEqual(["1", "2", "3", "1"]);
  });

  test("clears when the account signs out", () => {
    const { controller, labels } = watch(snapshot({ everyone: 4 }));
    controller.emit(snapshot({ everyone: 4 }, false));
    expect(labels).toEqual(["4", ""]);
  });

  test("clears and lets go of both sources when stopped, as when the plugin is turned off", () => {
    const { controller, labels, stop } = watch(snapshot({ everyone: 4 }));
    stop();
    expect(labels).toEqual(["4", ""]);
    expect(controller.listenerCount).toBe(0);

    controller.emit(snapshot({ everyone: 9 }));
    appendNotificationLog({ body: "NVDA above 120", refId: "price:a1" }, 1);
    expect(labels).toEqual(["4", ""]);
  });

  test("keeps updating when the host throws", () => {
    const controller = fakeController(snapshot({}));
    const labels: string[] = [];
    watchUnreadBadge({
      controller,
      log: { get: getNotificationLog, subscribe: subscribeNotificationLog },
      setBadge: (label) => {
        labels.push(label);
        throw new Error("no dock");
      },
    });
    expect(() => controller.emit(snapshot({ everyone: 1 }))).not.toThrow();
    controller.emit(snapshot({ everyone: 2 }));
    expect(labels).toEqual(["1", "2"]);
  });
});
