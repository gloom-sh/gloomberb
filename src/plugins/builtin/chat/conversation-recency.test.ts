import { describe, expect, test } from "bun:test";
import type { ChatChannel } from "../../../api-client";
import {
  compareConversationActivity,
  conversationActivityAt,
  NO_ACTIVITY,
  orderConversationChannels,
  sortByConversationActivity,
} from "./conversation-recency";

const STARTED = "2026-05-01T00:00:00.000Z";
const at = (iso: string) => Date.parse(iso);

function dm(id: string, extra: Partial<ChatChannel> = {}): ChatChannel {
  return { id, name: id, kind: "direct", created_at: STARTED, ...extra };
}

describe("conversation recency", () => {
  test("sorts newest first, with no known activity after every dated one in its original order", () => {
    const activity: Record<string, number> = {
      a: at("2026-06-01T10:00:00Z"),
      c: at("2026-06-03T10:00:00Z"),
      e: at("2026-06-02T10:00:00Z"),
    };
    const ids = ["a", "b", "c", "d", "e"];
    expect(sortByConversationActivity(ids, (id) => activity[id] ?? NO_ACTIVITY)).toEqual(["c", "e", "a", "b", "d"]);
    // Two conversations active at the same moment also keep their order.
    expect(sortByConversationActivity(["x", "y"], () => at("2026-06-01T10:00:00Z"))).toEqual(["x", "y"]);
    expect(compareConversationActivity(NO_ACTIVITY, Number.NaN)).toBe(0);
  });

  test("dates a conversation from the server's last message and the newest one held here", () => {
    const channel = dm("dm:a", { lastMessageAt: "2026-06-01T00:00:00.000Z" });
    expect(conversationActivityAt(channel)).toBe(at("2026-06-01T00:00:00.000Z"));
    // A message that arrived since the channel list was read is newer.
    expect(conversationActivityAt(channel, { messageAt: "2026-06-02T00:00:00.000Z" })).toBe(at("2026-06-02T00:00:00.000Z"));
    // So is one that is still being sent.
    expect(conversationActivityAt(channel, {
      messageAt: "2026-06-02T00:00:00.000Z",
      pendingAt: "2026-06-04T00:00:00.000Z",
    })).toBe(at("2026-06-04T00:00:00.000Z"));
    // Older held messages never pull it back.
    expect(conversationActivityAt(channel, { messageAt: "2026-05-20T00:00:00.000Z" })).toBe(at("2026-06-01T00:00:00.000Z"));
  });

  test("a DM or group with no message time counts from when it was started, whether the server says it is empty or says nothing", () => {
    expect(conversationActivityAt(dm("dm:a", { lastMessageAt: null }))).toBe(at(STARTED));
    expect(conversationActivityAt(dm("dm:a"))).toBe(at(STARTED));
    expect(conversationActivityAt({ ...dm("grp:a", { lastMessageAt: null }), kind: "group" })).toBe(at(STARTED));
    // Undated, it has nothing: with no usable start, and any other kind of channel.
    expect(conversationActivityAt(dm("dm:a", { created_at: "not a date" }))).toBe(NO_ACTIVITY);
    expect(conversationActivityAt({ id: "general", name: "general", kind: "public", created_at: STARTED })).toBe(NO_ACTIVITY);
  });

  test("a new empty DM sorts above older DMs whose last message is older than its creation", () => {
    const channels = [
      dm("dm:old", { created_at: "2026-01-01T00:00:00.000Z", lastMessageAt: "2026-02-01T00:00:00.000Z" }),
      dm("dm:older", { created_at: "2025-12-01T00:00:00.000Z", lastMessageAt: "2026-03-01T00:00:00.000Z" }),
      dm("dm:new", { created_at: "2026-06-01T00:00:00.000Z", lastMessageAt: null }),
    ];
    const activity = Object.fromEntries(channels.map((channel) => [channel.id, conversationActivityAt(channel)]));
    expect(orderConversationChannels(channels, activity).map((channel) => channel.id)).toEqual(["dm:new", "dm:older", "dm:old"]);
  });

  test("orders only the DMs and groups, each into a slot a DM held", () => {
    const everyone: ChatChannel = { id: "everyone", name: "everyone", kind: "public", created_at: STARTED };
    const team: ChatChannel = { id: "team:ops", name: "ops", kind: "team", created_at: STARTED };
    const channels = [dm("dm:a"), everyone, dm("dm:b"), team, { ...dm("grp:c"), kind: "group" as const }];
    const ordered = orderConversationChannels(channels, {
      "dm:a": at("2026-06-01T00:00:00Z"),
      "dm:b": at("2026-06-03T00:00:00Z"),
      "grp:c": at("2026-06-02T00:00:00Z"),
    });
    expect(ordered.map((channel) => channel.id)).toEqual(["dm:b", "everyone", "grp:c", "team:ops", "dm:a"]);
  });
});
