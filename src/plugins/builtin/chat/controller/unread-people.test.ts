import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  apiClient,
  type ChatChannel,
  type ChatChannelState,
  type ChatMessage,
} from "../../../../api-client";
import { MemoryPluginPersistence } from "../../../../test-support/plugin-persistence";
import { ChatController } from "./index";

const ann = { id: "u-ann", username: "ann", displayName: "Ann" };
const bo = { id: "u-bo", username: "bo", displayName: "Bo" };
const cy = { id: "u-cy", username: "cy", displayName: "Cy" };

const channels: ChatChannel[] = [
  { id: "everyone", name: "everyone", kind: "public", created_at: "2026-03-26T12:10:05.684Z" },
  { id: "grp:desk", name: "desk", kind: "group", created_at: "2026-03-26T12:10:05.684Z" },
  { id: "dm:ann", name: "ann", kind: "direct", created_at: "2026-03-26T12:10:05.684Z", dmUser: ann },
];

let controller: ChatController;
let reads: Array<{ channelId: string; after?: string; before?: string; limit?: number }>;
let serverMessages: ChatMessage[];
let serverStates: ChatChannelState[];
let pushChannelState: ((state: ChatChannelState) => void) | undefined;

const original = {
  getSession: apiClient.getSession.bind(apiClient),
  getMessages: apiClient.getMessages.bind(apiClient),
  getChatPresence: apiClient.getChatPresence.bind(apiClient),
  getChatState: apiClient.getChatState.bind(apiClient),
  subscribeChatNotifications: apiClient.subscribeChatNotifications.bind(apiClient),
  subscribeChatChannelState: apiClient.subscribeChatChannelState.bind(apiClient),
  subscribeChatPresence: apiClient.subscribeChatPresence.bind(apiClient),
};

function post(id: number, user: typeof ann, content: string, channelId = "everyone"): ChatMessage {
  return {
    id: `${channelId}:m${String(id).padStart(4, "0")}`,
    channelId,
    content,
    replyToId: null,
    createdAt: new Date(Date.UTC(2026, 2, 28, 0, 0, id)).toISOString(),
    user,
  };
}

function state(channelId: string, lastReadMessageId: string, unreadCount: number): ChatChannelState {
  return { channelId, notificationsEnabled: false, lastReadMessageId, unreadCount };
}

/** Who the badge sees behind a channel's unread messages, in a fixed order. */
function who(channelId: string) {
  const people = controller.getSnapshot().unreadPeople[channelId];
  return people && { senders: [...people.senders].sort(), mentioners: [...people.mentioners].sort() };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function signIn() {
  const persistence = new MemoryPluginPersistence();
  persistence.setState("session", {
    sessionToken: "token-123",
    user: { id: "u-me", username: "vince", emailVerified: true },
  }, { schemaVersion: 1 });
  controller.attachPersistence(persistence);
  await controller.refreshSession();
  await settle();
}

beforeEach(() => {
  controller = new ChatController();
  reads = [];
  serverMessages = [];
  serverStates = [];
  pushChannelState = undefined;
  apiClient.getSession = async () => ({
    id: "u-me",
    name: "Vince",
    email: "vince@example.com",
    username: "vince",
    emailVerified: true,
    image: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  apiClient.getChatPresence = async () => ({ onlineCount: 0 });
  apiClient.getChatState = async () => ({
    channels,
    onlineCount: 0,
    channelStates: serverStates,
    notifications: [],
  });
  apiClient.subscribeChatNotifications = () => () => {};
  apiClient.subscribeChatPresence = () => () => {};
  apiClient.subscribeChatChannelState = (listener) => {
    pushChannelState = listener;
    return () => {};
  };
  // The server's answer: the newest `limit` messages strictly between `after` and `before`, oldest first.
  apiClient.getMessages = async (channelId, options = {}) => {
    // The chat's own latest-page reads of the default channel are not what is checked here.
    if (options.after) reads.push({ channelId, ...options });
    let list = serverMessages.filter((message) => message.channelId === channelId);
    if (options.after) list = list.slice(list.findIndex((message) => message.id === options.after) + 1);
    if (options.before) list = list.slice(0, list.findIndex((message) => message.id === options.before));
    return list.slice(-(options.limit ?? 50));
  };
});

afterEach(() => {
  controller.dispose();
  apiClient.dispose();
  apiClient.setSessionToken(null);
  Object.assign(apiClient, original);
});

describe("unread people", () => {
  test("reads the unread messages this device does not hold, and sees who mentions you without changing the counts", async () => {
    serverMessages = [
      post(1, ann, "marker"),
      post(2, bo, "morning"),
      post(3, cy, "@vince thoughts on CPI?"),
      post(4, bo, "same here"),
      post(1, bo, "marker", "grp:desk"),
      post(2, ann, "lunch?", "grp:desk"),
      post(3, bo, "ok", "grp:desk"),
    ];
    serverStates = [
      state("everyone", "everyone:m0001", 3),
      state("grp:desk", "grp:desk:m0001", 2),
      state("dm:ann", "dm:ann:m0001", 4),
    ];
    await signIn();

    expect(who("everyone")).toEqual({ senders: [bo.id, cy.id], mentioners: [cy.id] });
    expect(who("grp:desk")).toEqual({ senders: [ann.id, bo.id], mentioners: [] });
    // Every unread message in a DM is from the other person: nothing to read.
    expect(who("dm:ann")).toEqual({ senders: [ann.id], mentioners: [] });
    expect(reads.map((read) => read.channelId).sort()).toEqual(["everyone", "grp:desk"]);
    expect(controller.getSnapshot().channelStates.map((entry) => [entry.channelId, entry.unreadCount])).toEqual([
      ["everyone", 3],
      ["grp:desk", 2],
      ["dm:ann", 4],
    ]);
  });

  test("reads a long run back page by page, and a count that grows reads only what is new", async () => {
    serverMessages = [
      post(1, ann, "marker"),
      post(2, cy, "@vince the oldest unread"),
      ...Array.from({ length: 149 }, (_, index) => post(index + 3, bo, "noise")),
    ];
    serverStates = [state("everyone", "everyone:m0001", 150)];
    await signIn();

    expect(who("everyone")).toEqual({ senders: [bo.id, cy.id], mentioners: [cy.id] });
    expect(reads).toEqual([
      { channelId: "everyone", after: "everyone:m0001", before: undefined, limit: 100 },
      { channelId: "everyone", after: "everyone:m0001", before: "everyone:m0052", limit: 100 },
    ]);

    // Two more arrive; the next read starts after the newest one already read.
    serverMessages.push(post(200, ann, "@vince also this"), post(201, ann, "and this"));
    reads = [];
    pushChannelState?.(state("everyone", "everyone:m0001", 152));
    await settle();

    expect(reads).toEqual([{ channelId: "everyone", after: "everyone:m0151", before: undefined, limit: 100 }]);
    expect(who("everyone")).toEqual({ senders: [ann.id, bo.id, cy.id], mentioners: [ann.id, cy.id] });
  });

  test("forgets what it read when you sign out, and when the channel is read", async () => {
    serverMessages = [post(1, ann, "marker"), post(2, cy, "@vince hi")];
    serverStates = [state("everyone", "everyone:m0001", 1)];
    await signIn();
    expect(who("everyone")?.mentioners).toEqual([cy.id]);

    pushChannelState?.(state("everyone", "everyone:m0002", 0));
    expect(controller.getSnapshot().unreadPeople).toEqual({});

    // The next unread message is after the new marker; the old mention is not carried over.
    serverMessages.push(post(3, bo, "no tag"));
    pushChannelState?.(state("everyone", "everyone:m0002", 1));
    await settle();
    expect(who("everyone")).toEqual({ senders: [bo.id], mentioners: [] });

    controller.clearSession();
    expect(controller.getSnapshot().unreadPeople).toEqual({});
  });
});
