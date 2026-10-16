import { describe, expect, test } from "bun:test";
import type { ChatChannel } from "../../../api-client";
import type { ConversationActivity } from "./conversation-recency";
import { buildChatSidebarRows } from "./sidebar-rows";

const CREATED = "2026-05-01T00:00:00.000Z";
const channel = (id: string, kind: ChatChannel["kind"] = "public"): ChatChannel => ({ id, name: id, kind, created_at: CREATED });

const channels: ChatChannel[] = [
  channel("everyone"),
  channel("equities"),
  channel("dm:alice", "direct"),
  channel("team:ops", "team"),
  channel("dm:bob", "direct"),
  channel("grp:desk", "group"),
  channel("dm:carol", "direct"),
];

function rowIds(conversationActivity: ConversationActivity, list = channels): string[] {
  return buildChatSidebarRows({
    channels: list,
    collapsedSections: new Set(),
    collapsedTeams: new Set(),
    canCreateConversation: true,
    conversationActivity,
    getTeam: () => null,
  }).flatMap((row) => (row.kind === "channel" ? [row.channel.id] : []));
}

const at = (iso: string) => Date.parse(iso);

describe("sidebar rows", () => {
  test("DMs and groups follow their newest message; public and team channels keep their order", () => {
    expect(rowIds({
      "dm:alice": at("2026-06-01T09:00:00Z"),
      "dm:bob": at("2026-06-01T12:00:00Z"),
      "grp:desk": at("2026-06-01T10:00:00Z"),
      "dm:carol": at("2026-06-01T08:00:00Z"),
    })).toEqual(["everyone", "equities", "team:ops", "dm:bob", "grp:desk", "dm:alice", "dm:carol"]);
  });

  test("a conversation with no known activity goes last and the others keep the order they came in", () => {
    const rows = rowIds({ "dm:carol": at("2026-06-01T08:00:00Z") });
    expect(rows.slice(3)).toEqual(["dm:carol", "dm:alice", "dm:bob", "grp:desk"]);
    expect(rowIds({}).slice(3)).toEqual(["dm:alice", "dm:bob", "grp:desk", "dm:carol"]);
  });

  test("a new message moves its conversation to the top", () => {
    const before = {
      "dm:alice": at("2026-06-01T09:00:00Z"),
      "dm:bob": at("2026-06-01T12:00:00Z"),
      "dm:carol": at("2026-06-01T08:00:00Z"),
    };
    expect(rowIds(before).slice(3)).toEqual(["dm:bob", "dm:alice", "dm:carol", "grp:desk"]);
    expect(rowIds({ ...before, "dm:carol": at("2026-06-01T13:00:00Z") }).slice(3)).toEqual([
      "dm:carol",
      "dm:bob",
      "dm:alice",
      "grp:desk",
    ]);
  });
});
