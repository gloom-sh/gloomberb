import { describe, expect, test } from "bun:test";
import type { ChatChannel, ChatMessage } from "../../../../api-client";
import {
  applyMentionSuggestion,
  buildRecentMentionSuggestions,
  detectChatMentionTrigger,
  filterMentionSuggestions,
} from "./mentions";

const message = (id: string, username: string): ChatMessage => ({
  id,
  channelId: "everyone",
  content: id,
  replyToId: null,
  createdAt: `2026-06-30T00:00:0${id}.000Z`,
  user: { id: `u-${username}`, username, displayName: username },
});

describe("chat mention suggestions", () => {
  test("detects an active mention trigger at the caret", () => {
    expect(detectChatMentionTrigger("watch @al", "watch @al".length)).toEqual({
      start: 6,
      end: 9,
      query: "al",
    });
    expect(detectChatMentionTrigger("email a@b", "email a@b".length)).toBeNull();
    expect(detectChatMentionTrigger("done @al now", "done @al now".length)).toBeNull();
  });

  test("orders visible users by recent messages, filters by prefix, and skips direct channels", () => {
    const activeChannel: ChatChannel = {
      id: "everyone",
      name: "everyone",
      kind: "public",
      created_at: "2026-06-30T00:00:00.000Z",
    };
    const suggestions = buildRecentMentionSuggestions({
      activeChannel,
      currentUserId: "u-me",
      messages: [
        message("1", "alpha"),
        message("2", "bravo"),
        { ...message("3", "me"), user: { id: "u-me", username: "me", displayName: "me" } },
        message("4", "alpha"),
        message("5", "charlie"),
      ],
    });

    expect(suggestions.map((suggestion) => suggestion.username)).toEqual(["charlie", "alpha", "bravo"]);
    expect(filterMentionSuggestions(suggestions, "a").map((suggestion) => suggestion.username)).toEqual(["alpha"]);
    expect(buildRecentMentionSuggestions({
      activeChannel: {
        id: "dm:alpha",
        name: "alpha",
        kind: "direct",
        created_at: "2026-06-30T00:00:00.000Z",
      },
      currentUserId: "u-me",
      messages: [message("1", "alpha")],
    })).toEqual([]);
  });

  test("filters the full member set before the cap, matching display names and ranking activity", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      id: `u-member${index}`, username: `member${index}`, displayName: `Quiet Person${index}`,
      channelActivityAt: null as string | null, conversationActivityAt: null as string | null,
    }));
    candidates[8]!.conversationActivityAt = "2026-06-29T00:00:00Z";
    candidates[9]!.conversationActivityAt = "2026-06-30T00:00:00Z";
    candidates[7]!.channelActivityAt = "2026-06-28T00:00:00Z";
    const suggestions = buildRecentMentionSuggestions({
      activeChannel: { id: "everyone", name: "everyone", kind: "group", created_at: "" },
      currentUserId: "u-me", candidates,
      messages: [message("1", "member2"), message("2", "outsider"), message("3", "member2")],
    });
    expect(filterMentionSuggestions(suggestions, "").map(row => row.username))
      .toEqual(["member2", "member7", "member9", "member8", "member0"]);
    expect(filterMentionSuggestions(suggestions, "member11").map(row => row.username)).toEqual(["member11"]);
    expect(filterMentionSuggestions(suggestions, "PERSON11").map(row => row.username)).toEqual(["member11"]);
    expect(suggestions.some(row => row.username === "outsider")).toBe(false);
    expect(suggestions.filter(row => row.username === "member2")).toHaveLength(1);
    expect(filterMentionSuggestions(suggestions, "", 99)).toHaveLength(5);
    expect(buildRecentMentionSuggestions({ activeChannel: undefined, currentUserId: "u-me", candidates, messages: [] })).toHaveLength(12);
  });

  test("cold cache uses all loaded authors, then an authoritative empty set removes them", () => {
    const messages = Array.from({ length: 9 }, (_, index) => message(String(index), `person${index}`));
    const options = { activeChannel: undefined, currentUserId: "u-me", messages };
    expect(filterMentionSuggestions(buildRecentMentionSuggestions(options), "person0")).toHaveLength(1);
    expect(buildRecentMentionSuggestions({ ...options, candidates: [] })).toEqual([]);
    expect(detectChatMentionTrigger("@Élo", 4)?.query).toBe("Élo");
  });

  test("replaces only the active mention fragment", () => {
    const trigger = detectChatMentionTrigger("check @al", "check @al".length);
    expect(trigger).not.toBeNull();

    expect(applyMentionSuggestion("check @al", trigger!, {
      username: "alpha",
    })).toEqual({
      draft: "check @alpha ",
      cursorOffset: "check @alpha ".length,
    });
  });
});
