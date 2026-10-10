import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { ChatChannel, ChatUserSummary } from "../../../api-client";
import {
  describeConversationStartError,
  directMessageAction,
  directMessageAvailability,
  knownConversationRefusal,
} from "./direct-messages";

const open: ChatUserSummary = { id: "u-open", username: "open_door", displayName: "Open", acceptUnknownDms: true };
const closed: ChatUserSummary = { id: "u-closed", username: "closed_door", displayName: "Closed", acceptUnknownDms: false };
const bot: ChatUserSummary = { id: "u-bot", username: "helperbot", displayName: "Helper", accountType: "managed_llm", acceptUnknownDms: true };
const legacy: ChatUserSummary = { id: "u-legacy", username: "legacy", displayName: "Legacy" };
const users = new Map([open, closed, bot, legacy].map((user) => [user.username!, user]));
const dmWithClosed: ChatChannel = {
  id: "dm:closed",
  name: "@closed_door",
  kind: "direct",
  created_at: "2026-07-03T09:30:00.000Z",
  dmUser: closed,
};

describe("describeConversationStartError", () => {
  test("names a user the server does not know, in a DM and in a group", () => {
    const notFound = new ApiRequestError('Unknown chat channel "ghost"', 404);
    expect(describeConversationStartError(notFound, ["ghost"], users)).toBe("@ghost was not found.");
    // The server does not say which member; the name this app never saw is the one.
    expect(describeConversationStartError(new ApiRequestError("Unknown", 404), ["open_door", "ghost"], users))
      .toBe("@ghost was not found.");
  });

  test("names who refused when the server says DMs are closed to new people", () => {
    const refusal = new ApiRequestError("closed", 403, undefined, "dms_closed", { error: "dms_closed", username: "Stranger" });
    expect(describeConversationStartError(refusal, ["open_door", "stranger"], users))
      .toBe("@stranger only takes DMs from people they have written to first.");
    const direct = new ApiRequestError("closed", 403, undefined, "dms_closed");
    expect(describeConversationStartError(direct, ["stranger"], users))
      .toBe("@stranger only takes DMs from people they have written to first.");
  });

  test("keeps any other refusal, a block among them, neutral", () => {
    // A block reaches the client as the plain 403 an older server sends for every refusal.
    const blocked = new ApiRequestError("Chat channel unavailable", 403);
    const message = describeConversationStartError(blocked, ["closed_door"], users);
    expect(message).toBe("Could not start the conversation (error 403).");
    expect(message).not.toContain("closed_door");
    expect(describeConversationStartError(new TypeError("Failed to fetch"), ["open_door"], users))
      .toBe("Could not start the conversation. Check your connection and try again.");
  });
});

describe("directMessageAvailability", () => {
  const context = { currentUserId: "u-self", channels: [dmWithClosed] };

  test("opens a DM you already share, even with someone who takes no new ones", () => {
    expect(directMessageAvailability(closed, context)).toEqual({ kind: "open", channelId: "dm:closed" });
    expect(directMessageAvailability(closed, { ...context, channels: [] })).toEqual({ kind: "refused", reason: "dms-off" });
  });

  test("refuses bots, starts with anyone else, and leaves yourself out", () => {
    expect(directMessageAvailability(bot, context)).toEqual({ kind: "refused", reason: "no-dms" });
    expect(directMessageAvailability(open, context)).toEqual({ kind: "start" });
    // A summary from a server that predates the setting is not treated as a refusal.
    expect(directMessageAvailability(legacy, context)).toEqual({ kind: "start" });
    expect(directMessageAvailability({ ...open, id: "u-self" }, context)).toEqual({ kind: "self" });
  });

  test("a shared DM does not let someone with DMs closed into a new group", () => {
    const context = { userByUsername: users, currentUserId: "u-self", channels: [dmWithClosed] };
    expect(knownConversationRefusal(["closed_door"], context)).toBeNull();
    expect(knownConversationRefusal(["open_door", "closed_door"], context))
      .toBe("@closed_door only takes DMs from people they have written to first.");
    expect(knownConversationRefusal(["open_door", "unknown_name"], context)).toBeNull();
  });
});

describe("directMessageAction", () => {
  const context = { currentUserId: "u-self", channels: [dmWithClosed], canSend: true };

  test("offers Message to someone who takes DMs, and Open DM where one is shared", () => {
    expect(directMessageAction(open, context)).toMatchObject({ kind: "start", menuLabel: "Message @open_door", buttonLabel: "Message" });
    // Their setting refuses new DMs, but the one you share stays open.
    expect(directMessageAction(closed, context)).toMatchObject({ kind: "open", menuLabel: "Open DM with @closed_door", buttonLabel: "Open DM" });
  });

  test("refuses a bot and someone who takes no new DMs, and offers nothing for yourself or before you can send", () => {
    expect(directMessageAction(bot, context)).toMatchObject({ kind: "refused", refusal: "Does not take DMs." });
    expect(directMessageAction(closed, { ...context, channels: [] }))
      .toMatchObject({ kind: "refused", refusal: "Only takes DMs from people they have written to first." });
    expect(directMessageAction({ ...open, id: "u-self" }, context)).toBeNull();
    expect(directMessageAction(open, { ...context, canSend: false })).toBeNull();
  });
});
