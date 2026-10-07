import { describe, expect, test } from "bun:test";
import type { ChatChannel, ChatMessage, ChatUserSummary } from "../../../api-client";
import { listUnreadInboxItems, type UnreadInboxChannelState } from "./unread-inbox";

const me = { id: "u-me", username: "vince" };

// User summaries as GET /chat/channels/:id/messages sends them for a private profile.
function person(id: string, username: string): ChatUserSummary {
  return {
    id,
    username,
    displayName: username,
    bio: null,
    company: null,
    title: null,
    profilePublic: false,
    acceptUnknownDms: false,
  };
}

const bob = person("u-bob", "bob");
const self = person(me.id, me.username);

function message(id: string, channelId: string, minute: number, content: string, user = bob): ChatMessage {
  return {
    id,
    channelId,
    content,
    replyToId: null,
    createdAt: `2026-10-05T12:${String(minute).padStart(2, "0")}:00.000Z`,
    user,
  };
}

const CHANNELS: ChatChannel[] = [
  { id: "everyone", name: "everyone", kind: "public", created_at: "2026-03-26T12:10:05.684Z" },
  { id: "macro", name: "macro", kind: "public", created_at: "2026-05-09T16:04:55.408Z" },
  { id: "options", name: "options", kind: "public", created_at: "2026-05-09T16:04:55.408Z" },
  {
    id: "dm:3f2a9c",
    name: "bob",
    kind: "direct",
    created_at: "2026-05-27T10:30:03.712Z",
    dmUser: bob,
  },
];

function list(states: UnreadInboxChannelState[], user: typeof me | null = me) {
  return listUnreadInboxItems({ channels: CHANNELS, states, user });
}

describe("listUnreadInboxItems", () => {
  test("keeps the account's counts and previews only messages after the read marker", () => {
    const items = list([
      {
        channelId: "everyone",
        unreadCount: 1,
        lastViewedMessageId: "e1",
        messages: [
          message("e0", "everyone", 1, "read before the marker"),
          message("e1", "everyone", 2, "the marker"),
          message("e2", "everyone", 3, "after the marker"),
          message("e3", "everyone", 4, "my own reply", self),
        ],
      },
      {
        // Read up to a message this device never cached: its cached messages
        // may all be read already, so none is shown, but the count stays.
        channelId: "macro",
        unreadCount: 3,
        lastViewedMessageId: "m-elsewhere",
        messages: [message("m1", "macro", 9, "possibly read on another device")],
      },
      { channelId: "options", unreadCount: 0, lastViewedMessageId: "o1", messages: [] },
      // Not one of the account's channels any more.
      { channelId: "grp:left", unreadCount: 4, lastViewedMessageId: null, messages: [] },
    ]);

    expect(items.map((item) => [item.title, item.unreadCount, item.preview?.id ?? null])).toEqual([
      ["#everyone", 1, "e2"],
      ["#macro", 3, null],
    ]);
    expect(list([{ channelId: "everyone", unreadCount: 2, lastViewedMessageId: null, messages: [] }], null)).toEqual([]);
  });

  test("a mention of you is the preview over a later message, and the newest known activity leads", () => {
    const items = list([
      {
        channelId: "everyone",
        unreadCount: 2,
        lastViewedMessageId: "e0",
        messages: [
          message("e0", "everyone", 1, "the marker"),
          message("e1", "everyone", 2, "@vince what do you make of this?"),
          message("e2", "everyone", 5, "later, and not to you"),
        ],
      },
      {
        channelId: "dm:3f2a9c",
        unreadCount: 1,
        lastViewedMessageId: "d0",
        messages: [message("d0", "dm:3f2a9c", 1, "the marker"), message("d1", "dm:3f2a9c", 3, "lunch?")],
      },
      { channelId: "options", unreadCount: 7, lastViewedMessageId: "o-elsewhere", messages: [] },
      { channelId: "macro", unreadCount: 2, lastViewedMessageId: "m-elsewhere", messages: [] },
    ]);

    expect(items.map((item) => [item.title, item.preview?.id ?? null, item.mentionsYou])).toEqual([
      ["#everyone", "e1", true],
      ["@bob", "d1", false],
      ["#options", null, false],
      ["#macro", null, false],
    ]);
  });
});
