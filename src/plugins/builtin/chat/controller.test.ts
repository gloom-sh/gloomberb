import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppNotificationRequest } from "../../../types/plugin";
import { MemoryPluginPersistence as MemoryPersistence } from "../../../test-support/plugin-persistence";
import { apiClient, type ChatChannel, type ChatMessage, type ChatNotification } from "../../../api-client";
import { ChatController } from "./controller";

const TRANSCRIPT_KIND = "channel-transcript";
const TRANSCRIPT_KEY = "everyone";
const TRANSCRIPT_SOURCE = "server";
const TRANSCRIPT_SCHEMA_VERSION = 2;
const originalConnectChannel = apiClient.connectChannel.bind(apiClient);
const originalGetSession = apiClient.getSession.bind(apiClient);
const originalGetMessages = apiClient.getMessages.bind(apiClient);
const originalGetChannels = apiClient.getChannels.bind(apiClient);
const originalGetChatPresence = apiClient.getChatPresence.bind(apiClient);
const originalGetChatState = apiClient.getChatState.bind(apiClient);
const originalUpdateChatChannelState = apiClient.updateChatChannelState.bind(apiClient);
const originalMarkChatNotificationsDelivered = apiClient.markChatNotificationsDelivered.bind(apiClient);
const originalSubscribeChatNotifications = apiClient.subscribeChatNotifications.bind(apiClient);
const originalSubscribeChatPresence = apiClient.subscribeChatPresence.bind(apiClient);
const originalEditMessage = apiClient.editMessage.bind(apiClient);

const SERVER_CHAT_CHANNELS: ChatChannel[] = [
  { id: "everyone", name: "everyone", created_at: "2026-03-26T12:10:05.684Z" },
  { id: "equities", name: "equities", created_at: "2026-05-09T00:00:00.000Z" },
  { id: "options", name: "options", created_at: "2026-05-09T00:00:00.000Z" },
  { id: "help", name: "help", created_at: "2026-05-09T00:00:00.000Z" },
];

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function recentChatTimestamp(offsetMs = 60_000) {
  return new Date(Date.now() - offsetMs).toISOString();
}

function mentionNotification(overrides: Partial<ChatNotification> = {}): ChatNotification {
  const channelId = overrides.channelId ?? "everyone";
  const messageId = overrides.messageId ?? "m1";
  const createdAt = overrides.createdAt ?? "2026-03-28T00:00:00.000Z";
  return {
    id: overrides.id ?? "n1",
    type: overrides.type ?? "mention",
    channelId,
    messageId,
    createdAt,
    message: overrides.message ?? {
      id: messageId,
      channelId,
      content: "hey @vince",
      replyToId: null,
      createdAt,
      user: { id: "u2", username: "bob", displayName: "Bob" },
    },
  };
}

class TrackingPersistence extends MemoryPersistence {
  stateWrites = 0;

  override setState(key: string, value: unknown, options?: { schemaVersion?: number }): void {
    this.stateWrites += 1;
    super.setState(key, value, options);
  }
}

beforeEach(() => {
  apiClient.getChatPresence = async () => ({ onlineCount: 0 });
  apiClient.getChatState = async () => ({
    channels: SERVER_CHAT_CHANNELS,
    onlineCount: 0,
    channelStates: SERVER_CHAT_CHANNELS.map((channel) => ({
      channelId: channel.id,
      notificationsEnabled: false,
      lastReadMessageId: null,
      unreadCount: 0,
    })),
    notifications: [],
  });
  apiClient.updateChatChannelState = async (channelId, body) => ({
    channelId,
    notificationsEnabled: body.notificationsEnabled ?? false,
    lastReadMessageId: body.readThroughMessageId ?? null,
    unreadCount: 0,
  });
  apiClient.markChatNotificationsDelivered = async () => ({ delivered: 1 });
  apiClient.subscribeChatNotifications = () => () => {};
  apiClient.subscribeChatPresence = () => () => {};
});

afterEach(() => {
  apiClient.dispose();
  apiClient.setSessionToken(null);
  apiClient.setCookieSessionMode(false);
  apiClient.connectChannel = originalConnectChannel;
  apiClient.getSession = originalGetSession;
  apiClient.getMessages = originalGetMessages;
  apiClient.getChannels = originalGetChannels;
  apiClient.getChatPresence = originalGetChatPresence;
  apiClient.getChatState = originalGetChatState;
  apiClient.updateChatChannelState = originalUpdateChatChannelState;
  apiClient.markChatNotificationsDelivered = originalMarkChatNotificationsDelivered;
  apiClient.subscribeChatNotifications = originalSubscribeChatNotifications;
  apiClient.subscribeChatPresence = originalSubscribeChatPresence;
  apiClient.editMessage = originalEditMessage;
});

describe("ChatController", () => {
  test("hydrates cached session, draft, and transcript from plugin persistence", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const message: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "hello",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u1", username: "vince", displayName: "Vince" },
    };

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince" },
    }, { schemaVersion: 1 });
    persistence.setState("channel:everyone", {
      draft: "cached draft",
      replyToId: "m1",
      lastCursor: "2026-03-28T00:00:00.000Z",
      lastViewedMessageId: "m1",
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      messages: [message],
    }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });

    controller.attachPersistence(persistence);

    const snapshot = controller.getSnapshot();
    expect(apiClient.getSessionToken()).toBe("token-123");
    expect(snapshot.user?.username).toBe("vince");
    expect(snapshot.draft).toBe("cached draft");
    expect(snapshot.replyToId).toBe("m1");
    expect(snapshot.messages.map((entry) => entry.id)).toEqual(["m1"]);
  });

  test("uses a browser cookie session without exposing its token", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const sentMessages: string[] = [];

    apiClient.setCookieSessionMode(true);
    apiClient.restoreCachedUser({
      id: "u1",
      username: "vince",
      emailVerified: true,
    });
    apiClient.getSession = async () => apiClient.getCurrentUser();
    apiClient.connectChannel = () => ({
      send: async (content) => {
        sentMessages.push(content);
        return {
          id: "m1",
          channelId: "everyone",
          content,
          replyToId: null,
          createdAt: "2026-08-23T00:00:00.000Z",
          user: { id: "u1", username: "vince", displayName: "Vince" },
        };
      },
      close: () => {},
    });

    controller.attachPersistence(persistence);
    await controller.refreshSession();

    expect(apiClient.getSessionToken()).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({
      hasSavedSession: true,
      user: { id: "u1", username: "vince", emailVerified: true },
    });
    expect(controller.send("hello from the browser")).toBe(true);
    await flushMicrotasks();
    expect(sentMessages).toEqual(["hello from the browser"]);
    controller.dispose();
  });

  test("rejects unknown shortcut channels after the server list loads", async () => {
    const controller = new ChatController();
    apiClient.getChannels = async () => SERVER_CHAT_CHANNELS;

    await expect(controller.resolveRequiredChannelId("help")).resolves.toBe("help");
    await expect(controller.resolveRequiredChannelId("made-up")).rejects.toThrow(
      'Unknown chat channel "#made-up".',
    );
  });

  test("keeps private channels when a public refresh finishes after chat state", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const directChannel: ChatChannel = {
      id: "dm:u2",
      name: "u2",
      kind: "direct",
      created_at: "2026-03-28T00:00:00.000Z",
    };
    let resolvePublicChannels: ((channels: ChatChannel[]) => void) | undefined;

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    apiClient.getChannels = () => new Promise((resolve) => {
      resolvePublicChannels = resolve;
    });
    apiClient.getChatState = async () => ({
      channels: [...SERVER_CHAT_CHANNELS, directChannel],
      onlineCount: 0,
      channelStates: [],
      notifications: [],
    });
    controller.attachPersistence(persistence);

    const publicRefresh = controller.refreshChannels();
    await controller.refreshChatState();
    expect(controller.getChannels().map((channel) => channel.id)).toContain(directChannel.id);

    resolvePublicChannels!(SERVER_CHAT_CHANNELS);
    await publicRefresh;

    expect(controller.getChannels().map((channel) => channel.id)).toContain(directChannel.id);
  });

  test("hydrates a cached verified user into the api client for offline use", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    controller.attachPersistence(persistence);

    expect(apiClient.getCurrentUser()).toMatchObject({
      id: "u1",
      username: "vince",
      emailVerified: true,
    });
    await expect(apiClient.ensureVerifiedSession()).resolves.toMatchObject({
      id: "u1",
      username: "vince",
      emailVerified: true,
    });
  });

  test("does not restore persisted websocket tokens", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();

    persistence.setState("session", {
      sessionToken: "token-123",
      websocketToken: "stale-ws-token",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    controller.attachPersistence(persistence);

    expect(apiClient.getSessionToken()).toBe("token-123");
    expect(apiClient.getWebSocketToken()).toBeNull();
    expect(apiClient.getCurrentUser()).toMatchObject({
      id: "u1",
      username: "vince",
      emailVerified: true,
    });
  });

  test("reset clears persisted chat state and session token", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince" },
    }, { schemaVersion: 1 });
    persistence.setState("channel:everyone", {
      draft: "cached draft",
      replyToId: null,
      lastCursor: null,
      lastViewedMessageId: null,
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      messages: [],
    }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });

    controller.attachPersistence(persistence);
    controller.reset(true);

    expect(apiClient.getSessionToken()).toBeNull();
    expect(persistence.getState("session", { schemaVersion: 1 })).toBeNull();
    expect(persistence.getResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    })).toBeNull();
  });

  test("defers draft persistence and subscriber sync until the user pauses or leaves", () => {
    const persistence = new TrackingPersistence();
    const controller = new ChatController();
    const draftSnapshots: string[] = [];

    controller.attachPersistence(persistence);
    const unsubscribe = controller.subscribe((snapshot) => {
      draftSnapshots.push(snapshot.draft);
    });
    draftSnapshots.length = 0;
    persistence.stateWrites = 0;

    controller.setDraft("h");
    controller.setDraft("he");

    expect(controller.getSnapshot().draft).toBe("he");
    expect(draftSnapshots).toEqual([]);
    expect(persistence.stateWrites).toBe(0);
    expect(persistence.getState("channel:everyone", { schemaVersion: 1 })).toBeNull();

    unsubscribe();
    controller.dispose();

    expect(persistence.getState<{ draft: string }>("channel:everyone", { schemaVersion: 1 })).toMatchObject({
      draft: "he",
    });
  });

  test("pauses verification polling while the app is backgrounded", () => {
    const controller = new ChatController();

    apiClient.setSessionToken("token-123");
    (controller as any).session.sessionToken = "token-123";
    (controller as any).session.user = { id: "u1", username: "vince", emailVerified: false };

    controller.setAppActive(false);
    (controller as any).realtime.syncVerificationPolling();
    expect((controller as any).realtime.verificationPollTimer).toBeNull();

    controller.setAppActive(true);
    expect((controller as any).realtime.verificationPollTimer).not.toBeNull();

    controller.reset(true);
  });

  test("dispose stops verification polling and closes the live connection", () => {
    const controller = new ChatController();
    let closed = false;

    apiClient.setSessionToken("token-123");
    (controller as any).session.sessionToken = "token-123";
    (controller as any).session.user = { id: "u1", username: "vince", emailVerified: false };
    (controller as any).realtime.syncVerificationPolling();
    expect((controller as any).realtime.verificationPollTimer).not.toBeNull();

    (controller as any).session.user = { id: "u1", username: "vince", emailVerified: true };
    apiClient.connectChannel = () => ({
      send: async () => {
        throw new Error("not implemented");
      },
      close: () => {
        closed = true;
      },
    });

    controller.ensureConnection();

    controller.dispose();

    expect(closed).toBe(true);
    expect((controller as any).realtime.verificationPollTimer).toBeNull();
  });

  test("runs a quiet safety refresh while the live connection is active", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const intervalCallbacks: Array<() => void> = [];
    const intervalHandle = { unref: () => {} };
    let cleared = false;
    let getMessagesCalls = 0;
    const loadingSnapshots: boolean[] = [];

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    (globalThis as any).setInterval = (callback: () => void, timeout: number) => {
      expect(timeout).toBe(30_000);
      intervalCallbacks.push(callback);
      return intervalHandle;
    };
    (globalThis as any).clearInterval = (handle: unknown) => {
      if (handle === intervalHandle) {
        cleared = true;
      }
    };

    try {
      apiClient.getMessages = async () => {
        getMessagesCalls += 1;
        return [];
      };
      apiClient.connectChannel = () => ({
        send: async () => {
          throw new Error("not implemented");
        },
        close: () => {},
      });

      controller.attachPersistence(persistence);
      controller.ensureConnection();
      await flushMicrotasks();

      expect(intervalCallbacks).toHaveLength(1);
      expect(getMessagesCalls).toBe(1);
      expect(controller.getSnapshot().loading).toBe(false);

      controller.subscribe((snapshot) => {
        loadingSnapshots.push(snapshot.loading);
      });
      loadingSnapshots.length = 0;

      intervalCallbacks[0]!();
      await flushMicrotasks();

      expect(getMessagesCalls).toBe(2);
      expect(loadingSnapshots).toEqual([false]);

      controller.clearSession();
      expect((controller as any).realtime.safetyRefreshTimer).toBeNull();
      expect(cleared).toBe(true);
    } finally {
      controller.dispose();
      (globalThis as any).setInterval = originalSetInterval;
      (globalThis as any).clearInterval = originalClearInterval;
    }
  });

  test("keeps a persisted native session when get-session returns no user", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    controller.attachPersistence(persistence);
    apiClient.getSession = async () => null;

    await controller.refreshSession();

    expect(apiClient.getSessionToken()).toBe("token-123");
    expect(persistence.getState<{
      sessionToken: string;
      user: { id: string; username: string; emailVerified: boolean };
    }>("session", { schemaVersion: 1 })).toEqual({
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    });
    expect(controller.getSnapshot().user).toEqual({
      id: "u1",
      username: "vince",
      emailVerified: true,
    });
    controller.dispose();
  });

  test("signs out when get-session returns no user and no token is stored", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();

    persistence.setState("session", {
      sessionToken: null,
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    controller.attachPersistence(persistence);
    apiClient.getSession = async () => null;

    await controller.refreshSession();

    expect(apiClient.getSessionToken()).toBeNull();
    expect(controller.getSnapshot().user).toBeNull();
    controller.dispose();
  });

  test("keeps the cached session when session refresh fails transiently", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    controller.attachPersistence(persistence);
    apiClient.getSession = async () => {
      throw new Error("network down");
    };

    await expect(controller.refreshSession()).rejects.toThrow("network down");
    expect(apiClient.getSessionToken()).toBe("token-123");
    expect(persistence.getState<{
      sessionToken: string;
      user: { id: string; username: string; emailVerified: boolean };
    }>("session", { schemaVersion: 1 })).toEqual({
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    });
    expect(controller.getSnapshot().user).toEqual({
      id: "u1",
      username: "vince",
      emailVerified: true,
    });
  });

  test("refreshes the public transcript without requiring a session", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const message: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "hello from the lobby",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u1", username: "vince", displayName: "Vince" },
    };

    controller.attachPersistence(persistence);
    apiClient.getMessages = async () => [message];

    await controller.refreshMessages();

    expect(controller.getSnapshot().messages).toEqual([message]);
    expect(persistence.getResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    })?.value).toEqual({
      messages: [message],
    });
  });

  test("keeps per-channel drafts and transcripts isolated", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const everyoneMessage: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "general",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u1", username: "vince", displayName: "Vince" },
    };
    const optionsMessage: ChatMessage = {
      id: "m2",
      channelId: "options",
      content: "options note",
      replyToId: null,
      createdAt: "2026-03-28T00:01:00.000Z",
      user: { id: "u2", username: "bob", displayName: "Bob" },
    };

    persistence.setState("channel:everyone", {
      draft: "general draft",
      replyToId: null,
      lastCursor: "m1",
      lastViewedMessageId: "m1",
    }, { schemaVersion: 1 });
    persistence.setState("channel:options", {
      draft: "options draft",
      replyToId: null,
      lastCursor: "m2",
      lastViewedMessageId: "m2",
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, "everyone", { messages: [everyoneMessage] }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });
    persistence.setResource(TRANSCRIPT_KIND, "options", { messages: [optionsMessage] }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });

    controller.attachPersistence(persistence);
    controller.setChannelDraft("options", "updated options");

    expect(controller.getSnapshot().messages.map((entry) => entry.content)).toEqual(["general"]);
    expect(controller.getSnapshot().draft).toBe("general draft");
    expect(controller.getSnapshot("options").messages.map((entry) => entry.content)).toEqual(["options note"]);
    expect(controller.getSnapshot("options").draft).toBe("updated options");
  });

  test("stores the latest message id as the incremental cursor", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const initial: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "hello",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u1", username: "vince", displayName: "Vince" },
    };
    const next: ChatMessage = {
      id: "m2",
      channelId: "everyone",
      content: "new message",
      replyToId: null,
      createdAt: "2026-03-28T00:01:00.000Z",
      user: { id: "u2", username: "bob", displayName: "Bob" },
    };

    persistence.setState("channel:everyone", {
      draft: "",
      replyToId: null,
      lastCursor: "m1",
      lastViewedMessageId: "m1",
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      messages: [initial],
    }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });

    controller.attachPersistence(persistence);

    const calls: Array<{ channelId: string; opts?: { after?: string; before?: string; limit?: number } }> = [];
    apiClient.getMessages = async (channelId, opts) => {
      calls.push({ channelId, opts });
      if (!opts?.after) return [initial, next];
      return opts.after === "m1" ? [next] : [];
    };

    await controller.refreshMessages();

    expect(calls[0]?.opts?.after).toBeUndefined();
    expect(controller.getSnapshot().messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(persistence.getState<{ lastCursor: string }>("channel:everyone", { schemaVersion: 1 })).toMatchObject({
      lastCursor: "m2",
    });

    await controller.refreshMessages();

    expect(calls[1]?.opts?.after).toBe("m2");
  });

  test("recovers a message the cursor already moved past", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const asked: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "why is the chart glitching",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u1", username: "vince", displayName: "Vince" },
    };
    const missed: ChatMessage = {
      id: "m2",
      channelId: "everyone",
      content: "charts open with GP",
      replyToId: "m1",
      createdAt: "2026-03-28T00:01:00.000Z",
      user: { id: "u2", username: "gloombot", displayName: "Gloombot" },
    };
    const acknowledged: ChatMessage = {
      id: "m3",
      channelId: "everyone",
      content: "got it",
      replyToId: null,
      createdAt: "2026-03-28T00:02:00.000Z",
      user: { id: "u1", username: "vince", displayName: "Vince" },
    };

    // The cursor already sits on m3, so an incremental fetch can never ask for
    // m2 again even though the server still has it.
    persistence.setState("channel:everyone", {
      draft: "",
      replyToId: null,
      lastCursor: "m3",
      lastViewedMessageId: "m3",
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      messages: [asked, acknowledged],
    }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });

    controller.attachPersistence(persistence);

    apiClient.getMessages = async (_channelId, opts) => (
      opts?.after ? [] : [asked, missed, acknowledged]
    );

    await controller.refreshMessages();

    expect(controller.getSnapshot().messages.map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("hydrates missing transcript cache without marking history unread", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const history: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "already seen",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u2", username: "bob", displayName: "Bob" },
    };

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    persistence.setState("channel:everyone", {
      draft: "",
      replyToId: null,
      lastCursor: "m1",
      lastViewedMessageId: "m1",
    }, { schemaVersion: 1 });

    controller.setNotifier((notification) => {
      notifications.push(notification);
    });
    controller.attachPersistence(persistence);

    const calls: Array<{ channelId: string; opts?: { after?: string; before?: string; limit?: number } }> = [];
    apiClient.getMessages = async (channelId, opts) => {
      calls.push({ channelId, opts });
      return opts?.after ? [] : [history];
    };

    await controller.refreshMessages();

    expect(calls).toEqual([{
      channelId: "everyone",
      opts: { limit: 50, after: undefined },
    }]);
    expect(controller.getSnapshot().messages).toEqual([history]);
    expect(controller.getSnapshot().channelStates.find((entry) => entry.channelId === "everyone")).toMatchObject({
      unreadCount: 0,
    });
    expect(notifications).toEqual([]);
  });

  test("backfills from cached transcript when persisted cursor is ahead of the cache", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const cached: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "cached",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u1", username: "vince", displayName: "Vince" },
    };
    const fresh: ChatMessage = {
      id: "m2",
      channelId: "everyone",
      content: "fresh",
      replyToId: null,
      createdAt: "2026-03-28T00:01:00.000Z",
      user: { id: "u2", username: "bob", displayName: "Bob" },
    };

    persistence.setState("channel:everyone", {
      draft: "",
      replyToId: null,
      lastCursor: "m99",
      lastViewedMessageId: "m1",
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      messages: [cached],
    }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });

    controller.attachPersistence(persistence);

    const calls: Array<{ channelId: string; opts?: { after?: string; before?: string; limit?: number } }> = [];
    apiClient.getMessages = async (channelId, opts) => {
      calls.push({ channelId, opts });
      return opts?.after ? [] : [cached, fresh];
    };

    await controller.refreshMessages();

    expect(calls[0]?.opts?.after).toBeUndefined();
    expect(controller.getSnapshot().messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(persistence.getState<{ lastCursor: string }>("channel:everyone", { schemaVersion: 1 })).toMatchObject({
      lastCursor: "m2",
    });

    await controller.refreshMessages();

    // The stale m99 cursor never reaches the server.
    expect(calls[1]?.opts?.after).toBe("m2");
  });

  test("shows a pending message immediately and replaces it when the send succeeds", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const replyTarget: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "first",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u2", username: "bob", displayName: "Bob" },
    };
    const sentMessage: ChatMessage = {
      id: "m2",
      channelId: "everyone",
      content: "hello",
      replyToId: "m1",
      createdAt: "2026-03-28T00:01:00.000Z",
      user: { id: "u1", username: "vince", displayName: "Vince" },
      replyTo: { content: "first", user: { username: "bob" } },
    };

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    persistence.setState("channel:everyone", {
      draft: "hello",
      replyToId: "m1",
      lastCursor: "m1",
      lastViewedMessageId: "m1",
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      messages: [replyTarget],
    }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });

    controller.attachPersistence(persistence);

    let resolveSend: (message: ChatMessage) => void = () => {
      throw new Error("send resolver was not captured");
    };
    apiClient.connectChannel = () => ({
      send: () => new Promise<ChatMessage>((resolve) => {
        resolveSend = resolve;
      }),
      close: () => {},
    });

    controller.send("hello", "m1");

    let snapshot = controller.getSnapshot();
    expect(snapshot.draft).toBe("");
    expect(snapshot.replyToId).toBeNull();
    expect(snapshot.messages.map((message) => message.id)).toEqual(["m1", snapshot.messages[1]!.id]);
    expect(snapshot.messages[1]).toMatchObject({
      content: "hello",
      replyToId: "m1",
      clientStatus: "sending",
      replyTo: { content: "first", user: { username: "bob" } },
    });

    resolveSend?.(sentMessage);
    await flushMicrotasks();

    snapshot = controller.getSnapshot();
    expect(snapshot.messages).toEqual([replyTarget, sentMessage]);
  });

  test("sends one idempotency key while the same message is pending", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const clientMessageIds: Array<string | undefined> = [];

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    controller.attachPersistence(persistence);
    apiClient.getMessages = async () => [];
    apiClient.connectChannel = () => ({
      send: (_content, _replyToId, clientMessageId) => {
        clientMessageIds.push(clientMessageId);
        return new Promise<ChatMessage>(() => {});
      },
      close: () => {},
    });

    const detachFirstView = controller.attachChannelView("everyone");
    const detachSecondView = controller.attachChannelView("everyone");

    controller.sendToChannel("everyone", " hello ");
    controller.sendToChannel("everyone", "hello");

    expect(clientMessageIds).toHaveLength(1);
    expect(clientMessageIds[0]).toBeTruthy();
    expect(controller.getSnapshot("everyone").messages).toHaveLength(1);

    detachFirstView();
    detachSecondView();
  });

  test("edits the latest message from the current user", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const original: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "helo",
      replyToId: null,
      createdAt: recentChatTimestamp(),
      user: { id: "u1", username: "vince", displayName: "Vince" },
    };

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      messages: [original],
    }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });
    controller.attachPersistence(persistence);
    apiClient.editMessage = async (channelId, messageId, content) => ({
      ...original,
      channelId,
      id: messageId,
      content,
      editedAt: "2026-03-28T00:01:00.000Z",
    });

    await expect(controller.editChannelMessage("everyone", "m1", "hello")).resolves.toBe(true);

    const [edited] = controller.getSnapshot().messages;
    expect(edited).toMatchObject({
      id: "m1",
      content: "hello",
      editedAt: "2026-03-28T00:01:00.000Z",
    });
  });

  test("refuses to edit after the edit window expires", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const original: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "old typo",
      replyToId: null,
      createdAt: recentChatTimestamp(16 * 60_000),
      user: { id: "u1", username: "vince", displayName: "Vince" },
    };

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      messages: [original],
    }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });
    controller.setNotifier((notification) => notifications.push(notification));
    controller.attachPersistence(persistence);
    apiClient.editMessage = async () => {
      throw new Error("should not call server");
    };

    await expect(controller.editChannelMessage("everyone", "m1", "old fix")).resolves.toBe(false);

    expect(controller.getSnapshot().messages[0]?.content).toBe("old typo");
    expect(notifications).toEqual([{ body: "Messages can only be edited within 15 minutes.", type: "error" }]);
  });

  test("refuses to edit an older message from the current user", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const messages: ChatMessage[] = [
      {
        id: "m1",
        channelId: "everyone",
        content: "older",
        replyToId: null,
        createdAt: "2026-03-28T00:00:00.000Z",
        user: { id: "u1", username: "vince", displayName: "Vince" },
      },
      {
        id: "m2",
        channelId: "everyone",
        content: "newer",
        replyToId: null,
        createdAt: "2026-03-28T00:01:00.000Z",
        user: { id: "u1", username: "vince", displayName: "Vince" },
      },
    ];

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      messages,
    }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });
    controller.setNotifier((notification) => notifications.push(notification));
    controller.attachPersistence(persistence);
    apiClient.editMessage = async () => {
      throw new Error("should not call server");
    };

    await expect(controller.editChannelMessage("everyone", "m1", "edited")).resolves.toBe(false);

    expect(controller.getSnapshot().messages.map((message) => message.content)).toEqual(["older", "newer"]);
    expect(notifications).toEqual([{ body: "Only your latest sent message can be edited.", type: "error" }]);
  });

  test("marks a pending message as failed when sending errors", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    controller.setNotifier((notification) => {
      notifications.push(notification);
    });
    controller.attachPersistence(persistence);

    apiClient.connectChannel = () => ({
      send: async () => {
        throw new Error("server offline");
      },
      close: () => {},
    });

    controller.send("hello");
    await flushMicrotasks();

    const snapshot = controller.getSnapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      content: "hello",
      clientStatus: "failed",
      clientError: "server offline",
    });
    expect(notifications).toEqual([{ body: "server offline", type: "error" }]);
  });

  test("tracks unread mentions from fetched messages without issuing local notifications", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const message: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "hey @Vince can you take a look?",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u2", username: "bob", displayName: "Bob" },
    };

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    controller.setNotifier((notification) => {
      notifications.push(notification);
    });
    controller.attachPersistence(persistence);

    (controller as any).mergeMessages([message]);

    expect(controller.getSnapshot().unreadMentionCount).toBe(1);
    expect(notifications).toEqual([]);
    expect(persistence.getState<{ lastCursor: string | null; lastViewedMessageId: string | null }>("channel:everyone", { schemaVersion: 1 })).toMatchObject({
      lastCursor: "m1",
      lastViewedMessageId: null,
    });
  });

  test("delivers background notifications while the focused chat stays unread", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const deliveredIds: string[][] = [];

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    controller.setNotifier((notification) => {
      notifications.push(notification);
      return { toastVisible: false, desktopRequested: true };
    });
    apiClient.markChatNotificationsDelivered = async (ids) => {
      deliveredIds.push(ids);
      return { delivered: ids.length };
    };
    controller.attachPersistence(persistence);
    const detachView = controller.attachView(true);
    controller.setAppActive(false);

    (controller as any).handleChatNotification(mentionNotification());

    expect(notifications).toEqual([{
      title: "#everyone",
      body: "@bob mentioned you: hey @vince",
      type: "info",
      desktop: "when-inactive",
    }]);
    expect(controller.getSnapshot().unreadMentionCount).toBe(1);
    expect(deliveredIds).toEqual([["n1"]]);

    controller.setAppActive(true);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(controller.getSnapshot().unreadMentionCount).toBe(0);
    detachView();
  });

  test("keeps undeliverable background notifications pending for email fallback", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const deliveredIds: string[][] = [];
    let desktopAvailable = false;
    let presentationCount = 0;

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    controller.setNotifier(() => {
      presentationCount += 1;
      return { toastVisible: false, desktopRequested: desktopAvailable };
    });
    apiClient.markChatNotificationsDelivered = async (ids) => {
      deliveredIds.push(ids);
      return { delivered: ids.length };
    };
    controller.attachPersistence(persistence);
    controller.setAppActive(false);

    const notification = mentionNotification({ type: "reply" });
    (controller as any).handleChatNotification(notification);

    expect(presentationCount).toBe(1);
    expect(deliveredIds).toEqual([]);

    desktopAvailable = true;
    (controller as any).handleChatNotification({ ...notification, id: "n2" });

    expect(presentationCount).toBe(2);
    expect(deliveredIds).toEqual([["n2"]]);
  });

  test("marks mentions viewed when a chat view opens", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const message: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "hey @vince",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u2", username: "bob", displayName: "Bob" },
    };

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    controller.setNotifier((notification) => {
      notifications.push(notification);
    });
    controller.attachPersistence(persistence);

    (controller as any).mergeMessages([message]);

    expect(controller.getSnapshot().unreadMentionCount).toBe(1);

    const detachView = controller.attachView();

    expect(controller.getSnapshot().unreadMentionCount).toBe(0);
    expect(notifications).toEqual([]);
    expect(persistence.getState<{ lastViewedMessageId: string | null }>("channel:everyone", { schemaVersion: 1 })).toMatchObject({
      lastViewedMessageId: "m1",
    });
    detachView();
  });

  test("keeps focused foreground notifications read without presenting an alert", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const deliveredIds: string[][] = [];

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });

    controller.setNotifier((notification) => {
      notifications.push(notification);
    });
    apiClient.markChatNotificationsDelivered = async (ids) => {
      deliveredIds.push(ids);
      return { delivered: ids.length };
    };
    controller.attachPersistence(persistence);
    const detachView = controller.attachView(true);

    (controller as any).handleChatNotification(mentionNotification());

    expect(controller.getSnapshot().unreadMentionCount).toBe(0);
    expect(notifications).toEqual([]);
    expect(deliveredIds).toEqual([["n1"]]);
    expect(persistence.getState<{ lastViewedMessageId: string | null }>("channel:everyone", { schemaVersion: 1 })).toMatchObject({
      lastViewedMessageId: "m1",
    });

    detachView();
  });

  test("keeps an unfocused foreground chat unread while presenting an in-app alert", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const deliveredIds: string[][] = [];

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    controller.setNotifier((notification) => {
      notifications.push(notification);
      return { toastVisible: true, desktopRequested: false };
    });
    apiClient.markChatNotificationsDelivered = async (ids) => {
      deliveredIds.push(ids);
      return { delivered: ids.length };
    };
    controller.attachPersistence(persistence);
    const detachUnfocusedView = controller.attachView(false);

    (controller as any).handleChatNotification(mentionNotification());

    expect(notifications).toHaveLength(1);
    expect(controller.getSnapshot().unreadMentionCount).toBe(1);
    expect(deliveredIds).toEqual([["n1"]]);

    detachUnfocusedView();
    const detachFocusedView = controller.attachView(true);
    expect(controller.getSnapshot().unreadMentionCount).toBe(0);
    detachFocusedView();
  });

  test("loads server chat state, pending reply notifications, and acks delivery", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const deliveredIds: string[][] = [];

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    apiClient.getSession = async () => ({
      id: "u1",
      name: "Vince",
      email: "vince@example.com",
      username: "vince",
      emailVerified: true,
      image: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    apiClient.getChatState = async () => ({
      channels: SERVER_CHAT_CHANNELS,
      onlineCount: 7,
      channelStates: [{
        channelId: "options",
        notificationsEnabled: true,
        lastReadMessageId: "m1",
        unreadCount: 3,
      }],
      notifications: [{
        id: "n1",
        type: "reply",
        channelId: "options",
        messageId: "m2",
        createdAt: "2026-03-28T00:02:00.000Z",
        message: {
          id: "m2",
          channelId: "options",
          content: "answering you",
          replyToId: "m1",
          createdAt: "2026-03-28T00:02:00.000Z",
          user: { id: "u2", username: "bob", displayName: "Bob" },
          replyTo: { content: "question", user: { id: "u1", username: "vince" } },
        },
      }],
    });
    apiClient.markChatNotificationsDelivered = async (ids) => {
      deliveredIds.push(ids);
      return { delivered: ids.length };
    };
    apiClient.connectChannel = () => ({
      send: async () => {
        throw new Error("not implemented");
      },
      close: () => {},
    });

    controller.setNotifier((notification) => {
      notifications.push(notification);
      return { toastVisible: true, desktopRequested: false };
    });
    controller.attachPersistence(persistence);

    await controller.refreshSession();

    expect(controller.getSnapshot("options").onlineCount).toBe(7);
    expect(controller.getSnapshot("options").channelStates.find((entry) => entry.channelId === "options")).toMatchObject({
      notificationsEnabled: true,
      unreadCount: 3,
    });
    expect(notifications).toEqual([{
      title: "#options",
      body: "@bob replied to you: answering you",
      type: "info",
      desktop: "when-inactive",
    }]);
    expect(deliveredIds).toEqual([["n1"]]);
  });

  test("toggles channel notifications optimistically and keeps the channel connected", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const connectedChannels: string[] = [];

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    apiClient.updateChatChannelState = async (channelId, body) => ({
      channelId,
      notificationsEnabled: body.notificationsEnabled === true,
      lastReadMessageId: null,
      unreadCount: 0,
    });
    apiClient.connectChannel = (channelId) => {
      connectedChannels.push(channelId);
      return {
        send: async () => {
          throw new Error("not implemented");
        },
        close: () => {},
      };
    };

    controller.attachPersistence(persistence);
    controller.setChannelNotificationsEnabled("options", true);
    await flushMicrotasks();

    expect(controller.getSnapshot("options").channelStates.find((entry) => entry.channelId === "options")).toMatchObject({
      notificationsEnabled: true,
    });
    expect(connectedChannels).toContain("options");
  });

  test("dedupes reply notifications by message id", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const notification: ChatNotification = {
      id: "n1",
      type: "reply",
      channelId: "everyone",
      messageId: "m2",
      createdAt: "2026-03-28T00:02:00.000Z",
      message: {
        id: "m2",
        channelId: "everyone",
        content: "same reply",
        replyToId: "m1",
        createdAt: "2026-03-28T00:02:00.000Z",
        user: { id: "u2", username: "bob", displayName: "Bob" },
        replyTo: { content: "question", user: { id: "u1", username: "vince" } },
      },
    };

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    controller.setNotifier((entry) => {
      notifications.push(entry);
      return { toastVisible: true, desktopRequested: false };
    });
    controller.attachPersistence(persistence);

    (controller as any).handleChatNotification(notification);
    (controller as any).handleChatNotification({ ...notification, id: "n2" });

    expect(notifications).toHaveLength(1);
  });

  test("opens a server-issued channel notification at its exact message", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const openedMessages: string[] = [];
    const message: ChatMessage = {
      id: "m1",
      channelId: "options",
      content: "new option flow",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u2", username: "bob", displayName: "Bob" },
    };

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    controller.setNotifier((entry) => {
      notifications.push(entry);
    }, (channelId, messageId) => {
      openedMessages.push(`${channelId}:${messageId}`);
    });
    controller.attachPersistence(persistence);

    (controller as any).handleChatNotification({
      id: "n1",
      type: "channel",
      channelId: "options",
      messageId: "m1",
      createdAt: "2026-03-28T00:00:00.000Z",
      message,
    } satisfies ChatNotification);

    expect(notifications).toEqual([{
      title: "#options",
      body: "@bob: new option flow",
      type: "info",
      desktop: "when-inactive",
      action: expect.objectContaining({ label: "Open" }),
    }]);
    notifications[0]?.action?.onClick();
    expect(openedMessages).toEqual(["options:m1"]);
  });

  test("uses direct channel labels in server-issued notification titles", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const directChannel: ChatChannel = {
      id: "dm:u2",
      name: "u2",
      kind: "direct",
      created_at: "2026-03-28T00:00:00.000Z",
      dmUser: { id: "u2", username: "bob", displayName: "Bob" },
    };
    const message: ChatMessage = {
      id: "m1",
      channelId: directChannel.id,
      content: "ping",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u2", username: "bob", displayName: "Bob" },
    };

    apiClient.getChatState = async () => ({
      channels: [...SERVER_CHAT_CHANNELS, directChannel],
      onlineCount: 0,
      channelStates: [...SERVER_CHAT_CHANNELS, directChannel].map((channel) => ({
        channelId: channel.id,
        notificationsEnabled: false,
        lastReadMessageId: null,
        unreadCount: 0,
      })),
      notifications: [],
    });
    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    controller.setNotifier((entry) => {
      notifications.push(entry);
    });
    controller.attachPersistence(persistence);
    await controller.refreshChatState();

    (controller as any).handleChatNotification({
      id: "n1",
      type: "channel",
      channelId: directChannel.id,
      messageId: "m1",
      createdAt: "2026-03-28T00:00:00.000Z",
      message,
    } satisfies ChatNotification);

    expect(notifications).toEqual([{
      title: "@bob",
      body: "ping",
      type: "info",
      desktop: "when-inactive",
    }]);
  });

  test("tracks unread channel messages and clears them when the channel opens", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const message: ChatMessage = {
      id: "m1",
      channelId: "options",
      content: "new option flow",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u2", username: "bob", displayName: "Bob" },
    };

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    controller.attachPersistence(persistence);

    (controller as any).mergeMessages("options", [message]);

    expect(controller.getSnapshot("options").channelStates.find((entry) => entry.channelId === "options")).toMatchObject({
      unreadCount: 1,
    });

    const detachView = controller.attachChannelView("options");

    expect(controller.getSnapshot("options").channelStates.find((entry) => entry.channelId === "options")).toMatchObject({
      unreadCount: 0,
    });
    detachView();
  });

  test("server reply notifications fire even when channel notifications are disabled", () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const notifications: AppNotificationRequest[] = [];
    const message: ChatMessage = {
      id: "m2",
      channelId: "options",
      content: "reply without channel notify",
      replyToId: "m1",
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u2", username: "bob", displayName: "Bob" },
      replyTo: { content: "question", user: { id: "u1", username: "vince" } },
    };

    persistence.setState("session", {
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
    }, { schemaVersion: 1 });
    controller.setNotifier((notification) => {
      notifications.push(notification);
    });
    controller.attachPersistence(persistence);

    (controller as any).handleChatNotification({
      id: "n1",
      type: "reply",
      channelId: "options",
      messageId: "m2",
      createdAt: "2026-03-28T00:00:00.000Z",
      message,
    } satisfies ChatNotification);

    expect(notifications).toEqual([{
      title: "#options",
      body: "@bob replied to you: reply without channel notify",
      type: "info",
      desktop: "when-inactive",
    }]);
  });

  test("recovers from a legacy timestamp cursor by falling back to a full transcript fetch", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const cached: ChatMessage = {
      id: "m1",
      channelId: "everyone",
      content: "cached",
      replyToId: null,
      createdAt: "2026-03-28T00:00:00.000Z",
      user: { id: "u1", username: "vince", displayName: "Vince" },
    };
    const fullTranscript: ChatMessage[] = [
      cached,
      {
        id: "m2",
        channelId: "everyone",
        content: "fresh",
        replyToId: null,
        createdAt: "2026-03-28T00:01:00.000Z",
        user: { id: "u2", username: "bob", displayName: "Bob" },
      },
    ];

    persistence.setState("channel:everyone", {
      draft: "",
      replyToId: null,
      lastCursor: "2026-03-28T00:00:00.000Z",
      lastViewedMessageId: "m1",
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      messages: [cached],
    }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });

    controller.attachPersistence(persistence);

    const calls: Array<{ channelId: string; opts?: { after?: string; before?: string; limit?: number } }> = [];
    apiClient.getMessages = async (channelId, opts) => {
      calls.push({ channelId, opts });
      return opts?.after ? [] : fullTranscript;
    };

    await controller.refreshMessages();

    // The session backfill already ignores the cursor, so the legacy timestamp
    // is never sent and the old wasted round trip is gone.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts?.after).toBeUndefined();
    expect(controller.getSnapshot().messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(persistence.getState<{ lastCursor: string }>("channel:everyone", { schemaVersion: 1 })).toMatchObject({
      lastCursor: "m2",
    });
  });

  test("loads older messages before the oldest cached message without moving the latest cursor", async () => {
    const persistence = new MemoryPersistence();
    const controller = new ChatController();
    const cached: ChatMessage[] = [
      {
        id: "m3",
        channelId: "everyone",
        content: "cached older",
        replyToId: null,
        createdAt: "2026-03-28T00:03:00.000Z",
        user: { id: "u3", username: "cara", displayName: "Cara" },
      },
      {
        id: "m4",
        channelId: "everyone",
        content: "cached newer",
        replyToId: null,
        createdAt: "2026-03-28T00:04:00.000Z",
        user: { id: "u4", username: "drew", displayName: "Drew" },
      },
    ];
    const older: ChatMessage[] = [
      {
        id: "m1",
        channelId: "everyone",
        content: "oldest",
        replyToId: null,
        createdAt: "2026-03-28T00:01:00.000Z",
        user: { id: "u1", username: "alice", displayName: "Alice" },
      },
      {
        id: "m2",
        channelId: "everyone",
        content: "older",
        replyToId: null,
        createdAt: "2026-03-28T00:02:00.000Z",
        user: { id: "u2", username: "bob", displayName: "Bob" },
      },
    ];

    persistence.setState("channel:everyone", {
      draft: "",
      replyToId: null,
      lastCursor: "m4",
      lastViewedMessageId: "m4",
    }, { schemaVersion: 1 });
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, {
      messages: cached,
    }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });

    controller.attachPersistence(persistence);

    const calls: Array<{ channelId: string; opts?: { after?: string; before?: string; limit?: number } }> = [];
    apiClient.getMessages = async (channelId, opts) => {
      calls.push({ channelId, opts });
      return opts?.before === "m3" ? older : [];
    };

    await controller.loadOlderMessages();

    expect(calls).toEqual([{
      channelId: "everyone",
      opts: { limit: 50, before: "m3" },
    }]);
    expect(controller.getSnapshot().messages.map((entry) => entry.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(controller.getSnapshot().hasOlderMessages).toBe(false);
    expect(persistence.getState<{ lastCursor: string }>("channel:everyone", { schemaVersion: 1 })).toMatchObject({
      lastCursor: "m4",
    });
  });
});
