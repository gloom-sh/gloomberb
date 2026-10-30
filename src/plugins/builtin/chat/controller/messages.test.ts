import { expect, test } from "bun:test";
import type { ChatMessage } from "../../../../api-client";
import { getVisibleMessages, mergeChatMessages } from "./messages";
import { createEmptyChannelState } from "./state";

test("unchanged snapshots reuse the transcript, but every source-list replacement invalidates it", () => {
  const channel = createEmptyChannelState();
  const message = (id: string, minute: number): ChatMessage => ({
    id, channelId: "everyone", content: id, replyToId: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    user: { id: "reader", username: "reader", displayName: "Reader" },
  });
  channel.messages = [message("later", 2), message("earlier", 0)];
  channel.pendingMessages = [{ ...message("pending", 1), clientStatus: "sending" }];
  const first = getVisibleMessages(channel);
  expect(first.map(({ id }) => id)).toEqual(["earlier", "pending", "later"]);
  // Sorting the projection must not mutate its input or change it on reads.
  expect(channel.messages.map(({ id }) => id)).toEqual(["later", "earlier"]);
  channel.draft = "typing";
  channel.messagesLoading = true;
  channel.unreadCount = 4;
  expect(getVisibleMessages(channel)).toBe(first);

  channel.messages = channel.messages.map((entry) => entry.id === "later"
    ? { ...entry, content: "edited", reactions: [{ emoji: "👍", count: 1, me: true, users: [] }] }
    : entry);
  const edited = getVisibleMessages(channel);
  expect(edited).not.toBe(first);
  expect(edited.at(-1)?.content).toBe("edited");
  expect(edited.at(-1)?.reactions?.[0]?.count).toBe(1);
  expect(first.at(-1)?.content).toBe("later");

  channel.pendingMessages = channel.pendingMessages.map((entry) => ({ ...entry, clientStatus: "failed" }));
  const failed = getVisibleMessages(channel);
  expect(failed).not.toBe(edited);
  expect(failed[1]?.clientStatus).toBe("failed");
  expect(getVisibleMessages(channel)).toBe(failed);

  channel.messages = [message("older-page", -1), ...channel.messages, message("accepted", 1)];
  channel.pendingMessages = [];
  expect(getVisibleMessages(channel).map(({ id }) => id)).toEqual(["older-page", "earlier", "accepted", "later"]);
  channel.messages = [];
  expect(getVisibleMessages(channel)).toEqual([]);
  expect(getVisibleMessages(createEmptyChannelState())).not.toBe(getVisibleMessages(channel));
});

test("a Gloom Wire post counts as unread only when it mentions you", () => {
  const channel = createEmptyChannelState();
  const reader = { id: "reader", username: "Reader" };
  const wire = { id: "managed-llm-gloomwire", username: "gloomwire", displayName: "Gloom Wire", accountType: "managed_llm" as const };
  const person = { id: "person", username: "person", displayName: "Person" };
  const message = (id: string, user: ChatMessage["user"], content: string): ChatMessage => ({
    id, channelId: "equities", content, replyToId: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, Number(id.slice(1)))).toISOString(),
    user,
  });
  const merge = (messages: ChatMessage[]) => mergeChatMessages({
    channel, currentUser: reader, messages, viewActive: false, markViewed: () => {},
  });

  merge([
    message("m1", wire, "$NVDA: Nvidia beats on revenue"),
    message("m2", wire, "merged, thanks @readers"),
    message("m3", wire, "merged, thanks @reader!"),
    message("m4", person, "big print"),
    message("m5", { ...reader, displayName: "Reader" }, "agreed"),
  ]);
  expect(channel.unreadCount).toBe(2);
  // The same posts again, as a resync brings them, add nothing.
  merge([message("m1", wire, "$NVDA: Nvidia beats on revenue"), message("m3", wire, "merged, thanks @reader!")]);
  expect(channel.unreadCount).toBe(2);
});
