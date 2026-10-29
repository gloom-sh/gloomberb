import { afterEach, describe, expect, test } from "bun:test";
import type { ChatChannel, ChatChannelState, ChatMessage } from "../../../api-client";
import {
  appendNotificationLog,
  getNotificationLog,
  markNotificationLogRead,
  resetNotificationLogForTest,
  subscribeNotificationLog,
} from "../../../notifications/notification-log";
import { summarizeUnreadMessages } from "./controller/unread-people";
import type { ChatControllerSnapshot } from "./controller/state";
import { unreadBadgeCount, unreadForYou, unreadTotal, watchUnreadBadge } from "./unread-badge";

type Snapshot = Pick<
  ChatControllerSnapshot,
  "channels" | "channelStates" | "hasSavedSession" | "unreadPeople" | "user"
>;

const ME = { id: "u-me", username: "vince" };

/** An unread message: who sent it, what it says, and whose message it replies to. */
type Unread = [from: string, text: string, replyTo?: string];

function channelOf(id: string): ChatChannel {
  const kind = id.startsWith("dm:") ? "direct" : id.startsWith("grp:") ? "group" : id.startsWith("team:") ? "team" : "public";
  return { id, name: id, kind, created_at: "2026-01-01T00:00:00.000Z" };
}

function channelState(channelId: string, unreadCount: number): ChatChannelState {
  return { channelId, notificationsEnabled: false, lastReadMessageId: null, unreadCount };
}

/** Each message is sent after the one made before it. */
let sentSeconds = 0;

function message(channelId: string, [from, text, replyTo]: Unread, index: number): ChatMessage {
  sentSeconds += 1;
  return {
    id: `${channelId}:${index}`,
    channelId,
    content: text,
    replyToId: replyTo ? "earlier" : null,
    ...(replyTo ? { replyTo: { content: "earlier", user: { id: replyTo === ME.username ? ME.id : replyTo, username: replyTo } } } : {}),
    createdAt: new Date(Date.UTC(2026, 2, 28, 0, 0, sentSeconds)).toISOString(),
    user: { id: from, username: from, displayName: from },
  };
}

/** The controller's view of each channel's unread messages, by channel id; ids `dm:`, `grp:` and `team:` are DMs, groups and team channels. */
function snapshot(unread: Record<string, Unread[]>, signedIn = true): Snapshot {
  const entries = Object.entries(unread);
  return {
    channels: entries.map(([id]) => channelOf(id)),
    channelStates: entries.map(([id, messages]) => channelState(id, messages.length)),
    unreadPeople: Object.fromEntries(
      entries
        .filter(([, messages]) => messages.length > 0)
        .map(([id, messages]) => [id, summarizeUnreadMessages(
          messages.map((entry, index) => message(id, entry, index)),
          ME,
          { everyMessageForYou: /^(dm|grp):/.test(id) },
        )]),
    ),
    hasSavedSession: signedIn,
    user: signedIn ? { id: ME.id, username: ME.username, emailVerified: true } : null,
  };
}

/** `count` different people who each sent one DM. */
function dmsFrom(count: number): Snapshot {
  return snapshot(Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`dm:p${index}`, [[`p${index}`, "hi"] as Unread]]),
  ));
}

function fakeController(initial: Snapshot) {
  const listeners = new Set<(next: Snapshot) => void>();
  let tracking = 0;
  return {
    trackUnreadPeople() {
      tracking += 1;
      return () => {
        tracking -= 1;
      };
    },
    get tracking() {
      return tracking;
    },
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
  test("counts every channel's unread messages and the notices not yet read: the status bar keeps message counts", () => {
    const first = appendNotificationLog({ body: "NVDA above 120", refId: "price:a1" }, 1);
    appendNotificationLog({ body: "Earnings tomorrow", refId: "catalyst:c1" }, 2);
    markNotificationLogRead([first!.id]);
    const unread: Unread[] = [["ann", "hi"], ["ann", "hi again"]];
    expect(unreadTotal(snapshot({ everyone: [...unread, ["bo", "x"]], macro: [], "dm:ann": unread }), getNotificationLog())).toBe(6);
  });

  test("is zero signed out, even with notices waiting", () => {
    appendNotificationLog({ body: "NVDA above 120", refId: "price:a1" }, 1);
    expect(unreadTotal(snapshot({ everyone: [["ann", "hi"]] }, false), getNotificationLog())).toBe(0);
  });
});

describe("unreadBadgeCount", () => {
  const badge = (unread: Record<string, Unread[]>, signedIn = true) => unreadBadgeCount(snapshot(unread, signedIn), getNotificationLog());

  test("counts one person once however many DMs they sent", () => {
    expect(badge({ "dm:ann": [["ann", "hi"], ["ann", "you there?"], ["ann", "call me"]] })).toBe(1);
  });

  test("counts two people who sent DMs as two", () => {
    expect(badge({ "dm:ann": [["ann", "hi"], ["ann", "hi"]], "dm:bo": [["bo", "hey"]] })).toBe(2);
  });

  test("counts a person once overall across a DM and a mention in a channel", () => {
    expect(badge({
      "dm:ann": [["ann", "hi"]],
      everyone: [["ann", "@vince did you see this?"], ["cy", "morning"]],
    })).toBe(1);
  });

  test("counts nothing for untagged channel messages, whoever sent them", () => {
    expect(badge({
      everyone: [["ann", "morning"], ["bo", "CPI is out"], ["cy", "@vincent hello"], ["di", "vince?"]],
      "team:desk": [["ann", "standup"]],
    })).toBe(0);
  });

  test("counts a channel message that mentions you, once per person, and a mention in a team channel", () => {
    expect(badge({
      everyone: [["ann", "@vince thoughts?"], ["ann", "also @Vince"], ["bo", "(@vince)"]],
      "team:desk": [["cy", "@vince standup"]],
    })).toBe(3);
  });

  test("counts whoever replied to your message, as a mention", () => {
    expect(badge({ everyone: [["ann", "agreed", ME.username], ["bo", "agreed", "ann"]] })).toBe(1);
  });

  test("counts every message of a group chat, since it is for the people in it", () => {
    expect(badge({ "grp:desk": [["ann", "lunch?"], ["bo", "yes"], ["ann", "ok"]] })).toBe(2);
  });

  test("never counts your own messages", () => {
    expect(badge({ "dm:ann": [[ME.id, "hi"]], everyone: [[ME.id, "@vince me"]] })).toBe(0);
  });

  test("adds every unread missed notice to the people", () => {
    const first = appendNotificationLog({ body: "NVDA above 120", refId: "price:a1" }, 1);
    appendNotificationLog({ body: "Earnings tomorrow", refId: "catalyst:c1" }, 2);
    appendNotificationLog({ body: "Team invite", refId: "team:t1" }, 3);
    expect(badge({ "dm:ann": [["ann", "hi"], ["ann", "hi"]], everyone: [["bo", "morning"]] })).toBe(4);
    markNotificationLogRead([first!.id]);
    expect(badge({})).toBe(2);
  });

  test("is zero signed out, even with notices waiting", () => {
    appendNotificationLog({ body: "NVDA above 120", refId: "price:a1" }, 1);
    expect(badge({ "dm:ann": [["ann", "hi"]] }, false)).toBe(0);
  });
});

describe("unreadForYou", () => {
  const forYou = (unread: Record<string, Unread[]>) => unreadForYou(snapshot(unread));

  test("names the newest of the people who wrote to you or tagged you, and counts them once and their messages", () => {
    expect(forYou({
      "dm:ann": [["ann", "hi"], ["ann", "you there?"]],
      everyone: [["bo", "@vince thoughts?"], ["ann", "@vince also"], ["cy", "morning"]],
      "grp:desk": [["di", "lunch?"]],
      macro: [["ed", "CPI is out"]],
    })).toEqual({
      latest: { channelId: "grp:desk", messageId: "grp:desk:0", senderName: "di", direct: true },
      people: 3,
      messages: 5,
    });
  });

  test("names a reply to your message as for you, and nobody for chatter alone", () => {
    expect(forYou({ everyone: [["bo", "agreed", ME.username], ["cy", "morning"]] }).latest)
      .toEqual({ channelId: "everyone", messageId: "everyone:0", senderName: "bo", direct: false });
    expect(forYou({ everyone: [["bo", "morning"]] })).toEqual({ latest: null, people: 0, messages: 0 });
  });
});

describe("watchUnreadBadge", () => {
  test("sets the badge once per change of the label and not while it stays the same", () => {
    const { controller, labels } = watch(dmsFrom(2));
    expect(labels).toEqual(["2"]);

    controller.emit(dmsFrom(2));
    controller.emit(dmsFrom(3));
    controller.emit(dmsFrom(3));
    expect(labels).toEqual(["2", "3"]);

    controller.emit(dmsFrom(120));
    controller.emit(dmsFrom(150));
    expect(labels).toEqual(["2", "3", "99+"]);

    controller.emit(dmsFrom(0));
    expect(labels).toEqual(["2", "3", "99+", ""]);
  });

  test("makes no call while the count stays at zero, not even on stop", () => {
    const { controller, labels, stop } = watch(snapshot({ everyone: [] }));
    controller.emit(snapshot({ everyone: [["ann", "morning"]], macro: [] }));
    stop();
    expect(labels).toEqual([]);
  });

  test("follows the missed notices as they arrive and are read", () => {
    const { labels } = watch(dmsFrom(1));
    appendNotificationLog({ body: "NVDA above 120", refId: "price:a1" }, 1);
    appendNotificationLog({ body: "Earnings tomorrow", refId: "catalyst:c1" }, 2);
    markNotificationLogRead();
    expect(labels).toEqual(["1", "2", "3", "1"]);
  });

  test("clears when the account signs out", () => {
    const { controller, labels } = watch(dmsFrom(4));
    controller.emit({ ...dmsFrom(4), hasSavedSession: false, user: null });
    expect(labels).toEqual(["4", ""]);
  });

  test("clears and lets go of both sources when stopped, as when the plugin is turned off", () => {
    const { controller, labels, stop } = watch(dmsFrom(4));
    stop();
    expect(labels).toEqual(["4", ""]);
    expect(controller.listenerCount).toBe(0);

    controller.emit(dmsFrom(9));
    appendNotificationLog({ body: "NVDA above 120", refId: "price:a1" }, 1);
    expect(labels).toEqual(["4", ""]);
  });

  test("has the controller read who the unread messages are from only while it runs", () => {
    const { controller, stop } = watch(dmsFrom(1));
    expect(controller.tracking).toBe(1);
    stop();
    expect(controller.tracking).toBe(0);
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
    expect(() => controller.emit(dmsFrom(1))).not.toThrow();
    controller.emit(dmsFrom(2));
    expect(labels).toEqual(["1", "2"]);
  });
});
