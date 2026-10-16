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

  test("a server that says the conversation is empty leaves it undated; one that says nothing dates it from its start", () => {
    expect(conversationActivityAt(dm("dm:a", { lastMessageAt: null }))).toBe(NO_ACTIVITY);
    expect(conversationActivityAt(dm("dm:a"))).toBe(at(STARTED));
    expect(conversationActivityAt(dm("dm:a", { created_at: "not a date" }))).toBe(NO_ACTIVITY);
    expect(conversationActivityAt({ id: "general", name: "general", kind: "public", created_at: STARTED })).toBe(NO_ACTIVITY);
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
