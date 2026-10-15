import { expect, test } from "bun:test";
import type { ChatMessage } from "../../../../api-client";
import { getVisibleMessages } from "./messages";
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
