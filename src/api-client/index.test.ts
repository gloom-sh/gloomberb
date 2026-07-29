import { afterEach, describe, expect, jest, test } from "bun:test";
import type { AuthUser } from "./index";
import { apiClient, setCloudApiFetchTransport } from "./index";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

const verifiedUser: AuthUser = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  username: "test",
  emailVerified: true,
  image: null,
  createdAt: "2026-03-30T00:00:00.000Z",
  updatedAt: "2026-03-30T00:00:00.000Z",
};

function createResponse(body: unknown, options: { status?: number; cookies?: string[] } = {}): Response {
  const headers = {
    getSetCookie: () => options.cookies ?? [],
    get: (name: string) => {
      if (name.toLowerCase() !== "set-cookie") return null;
      return options.cookies?.[0] ?? null;
    },
  } as Headers;

  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    headers,
    text: async () => JSON.stringify(body),
  } as Response;
}

function mockFetch(handler: (input: Request | string | URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return handler as unknown as typeof fetch;
}

class TestWebSocket {
  readyState: number;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  closeCalls = 0;

  constructor(
    readonly url: string,
    initialReadyState: number,
  ) {
    this.readyState = initialReadyState;
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  closeWith(event: { code: number; reason: string }): void {
    this.readyState = 3;
    this.onclose?.(event);
  }
}

function installTestWebSocket(initialReadyState = 1): TestWebSocket[] {
  const sockets: TestWebSocket[] = [];

  class InstalledTestWebSocket extends TestWebSocket {
    static readonly OPEN = 1;

    constructor(url: string) {
      super(url, initialReadyState);
      sockets.push(this);
    }
  }

  globalThis.WebSocket = InstalledTestWebSocket as unknown as typeof WebSocket;
  return sockets;
}

function flushQuoteSubscriptionUpdates(): void {
  jest.runAllTimers();
}

afterEach(() => {
  apiClient.dispose();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  apiClient.setWebSocketToken(null);
  jest.useRealTimers();
});

describe("apiClient auth cookies", () => {
  test("captures secure session cookies after login and reuses them on session refresh", async () => {
    const seenCookies: Array<string | null> = [];

    globalThis.fetch = mockFetch(async (_input: Request | string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenCookies.push(headers.get("Cookie"));

      if (seenCookies.length === 1) {
        return createResponse(
          { token: "ws-token", user: verifiedUser },
          { cookies: ["__Secure-gloomberb.session_token=signed-token.value; Path=/; HttpOnly; Secure; SameSite=Lax"] },
        );
      }

      return createResponse({ user: verifiedUser });
    });

    await apiClient.signIn("test@example.com", "password");
    await apiClient.getSession();

    expect(apiClient.getSessionToken()).toBe("signed-token.value");
    expect(apiClient.getWebSocketToken()).toBe("ws-token");
    expect(seenCookies).toEqual([
      null,
      "__Secure-gloomberb.session_token=signed-token.value",
    ]);
  });

  test("uses an installed cloud API fetch transport for auth cookie capture", async () => {
    const seenCookies: Array<string | null> = [];
    globalThis.fetch = mockFetch(async () => {
      throw new Error("global fetch should not be used");
    });
    setCloudApiFetchTransport(async (_url, init) => {
      const headers = new Headers(init?.headers);
      seenCookies.push(headers.get("Cookie"));
      return createResponse(
        { token: "ws-token", user: verifiedUser },
        { cookies: ["gloomberb.session_token=signed-token.value; Path=/; HttpOnly; SameSite=Lax"] },
      );
    });

    await apiClient.signIn("test@example.com", "password");

    expect(apiClient.getSessionToken()).toBe("signed-token.value");
    expect(apiClient.getWebSocketToken()).toBe("ws-token");
    expect(seenCookies).toEqual([null]);
  });

  test("rejects login success without a captured session cookie", async () => {
    globalThis.fetch = mockFetch(async () => createResponse({ token: "raw-session-token", user: verifiedUser }));

    await expect(apiClient.signIn("test@example.com", "password")).rejects.toThrow(
      "could not save the login session",
    );
    expect(apiClient.getSessionToken()).toBeNull();
    expect(apiClient.getWebSocketToken()).toBeNull();
    expect(apiClient.getCurrentUser()).toBeNull();
  });

  test("replays both supported cookie names when restoring a saved session token", async () => {
    const seenCookies: Array<string | null> = [];
    apiClient.setSessionToken("persisted-token.value");

    globalThis.fetch = mockFetch(async (_input: Request | string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenCookies.push(headers.get("Cookie"));
      return createResponse({ user: verifiedUser });
    });

    await apiClient.getSession();

    expect(seenCookies).toEqual([
      "__Secure-gloomberb.session_token=persisted-token.value; gloomberb.session_token=persisted-token.value",
    ]);
  });

  test("keeps cached identity when session refresh is rejected without a hard account-missing response", async () => {
    apiClient.setSessionToken("persisted-token.value");
    apiClient.restoreCachedUser(verifiedUser);

    globalThis.fetch = mockFetch(async () => createResponse({ message: "Unauthorized" }, { status: 401 }));

    await expect(apiClient.getSession()).rejects.toThrow("Unauthorized");
    expect(apiClient.getSessionToken()).toBe("persisted-token.value");
    expect(apiClient.getCurrentUser()).toMatchObject({
      id: verifiedUser.id,
      username: verifiedUser.username,
      emailVerified: true,
    });
  });

  test("clears cached identity when session refresh says the account no longer exists", async () => {
    apiClient.setSessionToken("persisted-token.value");
    apiClient.setWebSocketToken("ws-token");
    apiClient.restoreCachedUser(verifiedUser);

    globalThis.fetch = mockFetch(async () => createResponse({ code: "USER_NOT_FOUND" }, { status: 403 }));

    await expect(apiClient.getSession()).resolves.toBeNull();
    expect(apiClient.getSessionToken()).toBeNull();
    expect(apiClient.getWebSocketToken()).toBeNull();
    expect(apiClient.getCurrentUser()).toBeNull();
  });

  test("clears local session on explicit sign out even if the server request fails", async () => {
    apiClient.setSessionToken("persisted-token.value");
    apiClient.setWebSocketToken("ws-token");
    apiClient.restoreCachedUser(verifiedUser);

    globalThis.fetch = mockFetch(async () => createResponse({ message: "server unavailable" }, { status: 503 }));

    await expect(apiClient.signOut()).rejects.toThrow("server unavailable");
    expect(apiClient.getSessionToken()).toBeNull();
    expect(apiClient.getWebSocketToken()).toBeNull();
    expect(apiClient.getCurrentUser()).toBeNull();
  });
});

describe("apiClient quote socket", () => {
  test("drops a stale websocket token after socket close so reconnect can use the session token", () => {
    const sockets = installTestWebSocket(0);
    apiClient.setSessionToken("session-token");
    apiClient.setWebSocketToken("stale-ws-token");
    apiClient.restoreCachedUser(verifiedUser);

    const unsubscribe = apiClient.subscribeQuotes([{ symbol: "AAPL" }], () => {});

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toContain("token=stale-ws-token");

    sockets[0]!.closeWith({ code: 1008, reason: "Unauthorized" });

    expect(apiClient.getWebSocketToken()).toBeNull();
    expect(apiClient.getSessionToken()).toBe("session-token");

    unsubscribe();
  });

  test("opens an anonymous market websocket and sends quote priority hints", () => {
    const sockets = installTestWebSocket();

    const unsubscribe = apiClient.subscribeQuotes([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      surface: "portfolio",
      visible: true,
      selected: true,
      weight: 100,
    }], () => {});
    sockets[0]!.open();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe("wss://api.gloom.sh/cloud/ws");
    expect(sockets[0]!.sent).toContainEqual({
      type: "market.subscribe",
      symbols: [{
        symbol: "AAPL",
        exchange: "NASDAQ",
        surface: "portfolio",
        visible: true,
        selected: true,
        weight: 100,
      }],
    });

    unsubscribe();
  });

  test("does not invent quote priority hints when opening a socket", () => {
    const sockets = installTestWebSocket();

    const unsubscribe = apiClient.subscribeQuotes([{ symbol: "AAPL", exchange: "NASDAQ" }], () => {});
    sockets[0]!.open();

    expect(sockets[0]!.sent).toContainEqual({
      type: "market.subscribe",
      symbols: [{ symbol: "AAPL", exchange: "NASDAQ" }],
    });

    unsubscribe();
  });

  test("recomputes quote priority when overlapping subscriptions are removed", () => {
    jest.useFakeTimers();
    const sockets = installTestWebSocket();
    const deliveredSurfaces: string[] = [];
    const unsubscribeInline = apiClient.subscribeQuotes([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      surface: "inline",
      weight: 1,
    }], (target) => {
      deliveredSurfaces.push(target.surface ?? "unknown");
    });
    const socket = sockets[0]!;
    socket.open();
    flushQuoteSubscriptionUpdates();
    socket.sent.length = 0;

    const unsubscribeDetail = apiClient.subscribeQuotes([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      surface: "detail",
      visible: true,
      selected: true,
      weight: 50,
    }], (target) => {
      deliveredSurfaces.push(target.surface ?? "unknown");
    });
    flushQuoteSubscriptionUpdates();

    expect(socket.sent.at(-1)).toEqual({
      type: "market.subscribe",
      symbols: [{
        symbol: "AAPL",
        exchange: "NASDAQ",
        surface: "detail",
        visible: true,
        selected: true,
        weight: 50,
      }],
    });

    socket.receive({
      type: "market.quote",
      symbol: "AAPL",
      exchange: "NASDAQ",
      quote: { symbol: "AAPL", price: 123 },
    });
    expect(deliveredSurfaces).toEqual(["inline", "detail"]);

    unsubscribeDetail();
    flushQuoteSubscriptionUpdates();
    expect(socket.sent.at(-1)).toEqual({
      type: "market.subscribe",
      symbols: [{
        symbol: "AAPL",
        exchange: "NASDAQ",
        surface: "inline",
        weight: 1,
      }],
    });

    unsubscribeInline();
  });

  test("unsubscribes a server-side quote when queued priority updates are removed", () => {
    jest.useFakeTimers();
    const sockets = installTestWebSocket();
    const unsubscribeMsft = apiClient.subscribeQuotes([{ symbol: "MSFT", exchange: "NASDAQ" }], () => {});
    const socket = sockets[0]!;
    socket.open();
    flushQuoteSubscriptionUpdates();

    const unsubscribeInline = apiClient.subscribeQuotes([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      surface: "inline",
      weight: 1,
    }], () => {});
    flushQuoteSubscriptionUpdates();
    expect(socket.sent.at(-1)).toEqual({
      type: "market.subscribe",
      symbols: [{ symbol: "AAPL", exchange: "NASDAQ", surface: "inline", weight: 1 }],
    });

    socket.sent.length = 0;
    const unsubscribeDetail = apiClient.subscribeQuotes([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      surface: "detail",
      visible: true,
      selected: true,
      weight: 50,
    }], () => {});
    unsubscribeDetail();
    unsubscribeInline();
    flushQuoteSubscriptionUpdates();

    expect(socket.sent).toEqual([{
      type: "market.unsubscribe",
      symbols: [{ symbol: "AAPL", exchange: "NASDAQ", surface: "inline", weight: 1 }],
    }]);
    unsubscribeMsft();
  });

  test("keeps an anonymous market websocket open after auth rejection", () => {
    const seenPrices: number[] = [];
    const sockets = installTestWebSocket();

    const unsubscribe = apiClient.subscribeQuotes([{ symbol: "AAPL" }], (_target, quote) => {
      seenPrices.push(quote.price);
    });
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ type: "auth.unverified" });
    socket.receive({
      type: "market.quote",
      symbol: "AAPL",
      exchange: "",
      quote: {
        symbol: "AAPL",
        price: 123,
        currency: "USD",
        change: 0,
        changePercent: 0,
        lastUpdated: 1,
        providerId: "gloomberb-cloud",
        dataSource: "live",
      },
    });

    expect(socket.closeCalls).toBe(0);
    expect(seenPrices).toEqual([123]);

    unsubscribe();
  });
});

describe("apiClient chat timestamps", () => {
  test("sends the before cursor when loading older chat messages", async () => {
    let requestedUrl = "";
    globalThis.fetch = mockFetch(async (input: Request | string | URL) => {
      requestedUrl = String(input);
      return createResponse([]);
    });

    await apiClient.getMessages("everyone", { limit: 50, before: "m42" });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/chat/channels/everyone/messages");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("before")).toBe("m42");
  });

  test("normalizes transcript and send-response timestamps to UTC ISO strings", async () => {
    const responses = [
      createResponse([{
        id: "m1",
        channelId: "everyone",
        content: "older",
        replyToId: null,
        createdAt: "2026-04-08 07:28:27.625",
        user: { id: "u1", username: "alice", displayName: "Alice" },
        replyTo: null,
      }]),
      createResponse({
        id: "m2",
        channelId: "everyone",
        content: "hello",
        replyToId: null,
        createdAt: "2026-04-08T07:29:27.625",
        user: { id: "u1", username: "alice", displayName: "Alice" },
        replyTo: null,
      }),
    ];

    globalThis.fetch = mockFetch(async () => responses.shift() as Response);

    const messages = await apiClient.getMessages("everyone", { limit: 1 });
    const sentMessage = await apiClient.sendMessage("everyone", "hello");

    expect(messages[0]?.createdAt).toBe("2026-04-08T07:28:27.625Z");
    expect(sentMessage.createdAt).toBe("2026-04-08T07:29:27.625Z");
  });

  test("edits a chat message and normalizes the edit timestamp", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    globalThis.fetch = mockFetch(async (input: Request | string | URL, init?: RequestInit) => {
      requests.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return createResponse({
        id: "m2",
        channelId: "everyone",
        content: "hello edited",
        replyToId: null,
        createdAt: "2026-04-08 07:29:27.625",
        editedAt: "2026-04-08 07:30:27.625",
        user: { id: "u1", username: "alice", displayName: "Alice" },
        replyTo: null,
      });
    });

    const editedMessage = await apiClient.editMessage("everyone", "m2", "hello edited");

    expect(requests).toEqual([{
      path: "/chat/channels/everyone/messages/m2",
      method: "PATCH",
      body: { content: "hello edited" },
    }]);
    expect(editedMessage.editedAt).toBe("2026-04-08T07:30:27.625Z");
  });

  test("normalizes websocket chat timestamps before notifying listeners", async () => {
    const seenCreatedAts: string[] = [];
    const channel = apiClient.connectChannel("everyone", (message) => {
      seenCreatedAts.push(message.createdAt);
    });

    await (apiClient as any).socket.handleSocketMessage(JSON.stringify({
      type: "chat.message",
      channelId: "everyone",
      data: {
        id: "m1",
        channelId: "everyone",
        content: "hello",
        replyToId: null,
        createdAt: "2026-04-08 07:28:27.625",
        user: { id: "u1", username: "alice", displayName: "Alice" },
        replyTo: null,
      },
    }));

    expect(seenCreatedAts).toEqual(["2026-04-08T07:28:27.625Z"]);
    channel.close();
  });

  test("fetches chat state and normalizes pending notification timestamps", async () => {
    let requestedUrl = "";
    globalThis.fetch = mockFetch(async (input: Request | string | URL) => {
      requestedUrl = String(input);
      return createResponse({
        channels: [{ id: "everyone", name: "everyone", created_at: "2026-04-08T07:00:00.000Z" }],
        onlineCount: 2,
        channelStates: [{
          channelId: "everyone",
          notificationsEnabled: true,
          lastReadMessageId: "m1",
          unreadCount: 1,
        }],
        notifications: [{
          id: "n1",
          type: "reply",
          channelId: "everyone",
          messageId: "m2",
          createdAt: "2026-04-08 07:30:00.000",
          message: {
            id: "m2",
            channelId: "everyone",
            content: "reply",
            replyToId: "m1",
            createdAt: "2026-04-08 07:29:00.000",
            user: { id: "u2", username: "bob", displayName: "Bob" },
            replyTo: { content: "parent", user: { id: "u1", username: "vince" } },
          },
        }],
      });
    });

    const state = await apiClient.getChatState();

    expect(new URL(requestedUrl).pathname).toBe("/chat/state");
    expect(state.onlineCount).toBe(2);
    expect(state.notifications[0]?.createdAt).toBe("2026-04-08T07:30:00.000Z");
    expect(state.notifications[0]?.message.createdAt).toBe("2026-04-08T07:29:00.000Z");
  });

  test("updates chat channel state and marks notifications delivered", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const responses = [
      createResponse({
        channelId: "everyone",
        notificationsEnabled: true,
        lastReadMessageId: "m2",
        unreadCount: 0,
      }),
      createResponse({ delivered: 2 }),
      createResponse({ onlineCount: 4 }),
    ];
    globalThis.fetch = mockFetch(async (input: Request | string | URL, init?: RequestInit) => {
      requests.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return responses.shift() as Response;
    });

    await apiClient.updateChatChannelState("everyone", {
      notificationsEnabled: true,
      readThroughMessageId: "m2",
    });
    await apiClient.markChatNotificationsDelivered(["n1", "n2"]);
    const presence = await apiClient.getChatPresence();

    expect(requests).toEqual([
      {
        path: "/chat/channels/everyone/state",
        method: "PATCH",
        body: { notificationsEnabled: true, readThroughMessageId: "m2" },
      },
      {
        path: "/chat/notifications/delivered",
        method: "POST",
        body: { notificationIds: ["n1", "n2"] },
      },
      {
        path: "/chat/presence",
        method: "GET",
        body: null,
      },
    ]);
    expect(presence).toEqual({ onlineCount: 4 });
  });

  test("emits websocket chat presence and notification events", async () => {
    const seenPresence: number[] = [];
    const seenNotifications: string[] = [];
    const unsubscribePresence = apiClient.subscribeChatPresence((onlineCount) => {
      seenPresence.push(onlineCount);
    });
    const unsubscribeNotifications = apiClient.subscribeChatNotifications((notification) => {
      seenNotifications.push(`${notification.id}:${notification.message.createdAt}`);
    });

    await (apiClient as any).socket.handleSocketMessage(JSON.stringify({
      type: "chat.presence",
      onlineCount: 5,
    }));
    await (apiClient as any).socket.handleSocketMessage(JSON.stringify({
      type: "chat.notification",
      data: {
        id: "n1",
        type: "reply",
        channelId: "everyone",
        messageId: "m2",
        createdAt: "2026-04-08 07:30:00.000",
        message: {
          id: "m2",
          channelId: "everyone",
          content: "reply",
          replyToId: "m1",
          createdAt: "2026-04-08 07:29:00.000",
          user: { id: "u2", username: "bob", displayName: "Bob" },
          replyTo: { content: "parent", user: { id: "u1", username: "vince" } },
        },
      },
    }));

    expect(seenPresence).toEqual([5]);
    expect(seenNotifications).toEqual(["n1:2026-04-08T07:29:00.000Z"]);
    unsubscribePresence();
    unsubscribeNotifications();
  });
});

describe("apiClient account profile", () => {
  test("updates profile fields through the account endpoint", async () => {
    let requestedUrl = "";
    let requestedBody = "";
    apiClient.setSessionToken("session-token");
    apiClient.restoreCachedUser(verifiedUser);
    globalThis.fetch = mockFetch(async (input: Request | string | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body ?? "");
      return createResponse({
        profile: {
          id: verifiedUser.id,
          email: verifiedUser.email,
          emailVerified: true,
          plan: "pro",
          username: "renamed",
          name: "Renamed User",
          company: "Gloomberb",
          title: "Founder",
          bio: "Markets.",
          profilePublic: true,
          publicEmail: "public@example.com",
          xAccount: "vincelwt",
          sharedPortfolioId: "main",
          acceptUnknownDms: true,
          chatEmailNotificationsEnabled: false,
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      });
    });

    const profile = await apiClient.updateAccountProfile({
      username: "renamed",
      name: "Renamed User",
      profilePublic: true,
      sharedPortfolioId: "main",
      acceptUnknownDms: true,
      chatEmailNotificationsEnabled: false,
    });

    expect(new URL(requestedUrl).pathname).toBe("/account/profile");
    expect(JSON.parse(requestedBody)).toEqual({
      username: "renamed",
      name: "Renamed User",
      profilePublic: true,
      sharedPortfolioId: "main",
      acceptUnknownDms: true,
      chatEmailNotificationsEnabled: false,
    });
    expect(profile.username).toBe("renamed");
    expect(apiClient.getCurrentUser()?.username).toBe("renamed");
    expect(apiClient.getCurrentUser()?.plan).toBe("pro");
    expect(apiClient.getCurrentUser()?.chatEmailNotificationsEnabled).toBe(false);
  });

  test("changes password through Better Auth", async () => {
    let requestedUrl = "";
    let requestedBody = "";
    apiClient.setSessionToken("session-token");
    globalThis.fetch = mockFetch(async (input: Request | string | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body ?? "");
      return createResponse({ status: true });
    });

    await apiClient.changePassword("old-password", "new-password");

    expect(new URL(requestedUrl).pathname).toBe("/auth/change-password");
    expect(JSON.parse(requestedBody)).toEqual({
      currentPassword: "old-password",
      newPassword: "new-password",
      revokeOtherSessions: false,
    });
  });
});

describe("apiClient cloud news", () => {
  test("uses the existing /news route with backend ticker filters", async () => {
    let seenUrl = "";
    globalThis.fetch = mockFetch(async (input: Request | string | URL) => {
      seenUrl = String(input);
      return createResponse({ items: [], nextCursor: null });
    });

    const result = await apiClient.getCloudNews({
      feed: "ticker",
      ticker: "AAPL",
      exchange: "NASDAQ",
      tickerTier: "primary",
      limit: 25,
      topics: ["earnings", "mna"],
      sectors: ["information_technology"],
      minImportance: 60,
      breaking: false,
      since: new Date("2026-04-01T00:00:00.000Z"),
      cursor: "cursor-1",
    });

    const url = new URL(seenUrl);
    expect(url.pathname).toBe("/news");
    expect(url.searchParams.get("feed")).toBe("ticker");
    expect(url.searchParams.get("tickers")).toBe("AAPL:XNAS");
    expect(url.searchParams.get("tickerTier")).toBe("primary");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("topics")).toBe("earnings,mna");
    expect(url.searchParams.get("sectors")).toBe("information_technology");
    expect(url.searchParams.get("minImportance")).toBe("60");
    expect(url.searchParams.get("breaking")).toBe("false");
    expect(url.searchParams.get("since")).toBe("2026-04-01T00:00:00.000Z");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
    expect(result).toEqual({ items: [], nextCursor: null });
  });

  test("fetches news story details from the story route", async () => {
    let seenUrl = "";
    globalThis.fetch = mockFetch(async (input: Request | string | URL) => {
      seenUrl = String(input);
      return createResponse({
        id: "story-1",
        headline: "Story headline",
        summary: "Story summary",
        category: "general",
        sentiment: "neutral",
        sectors: [],
        firstPublishedAt: "2026-04-01T10:00:00.000Z",
        lastPublishedAt: "2026-04-01T10:05:00.000Z",
        firstSeenAt: "2026-04-01T10:00:10.000Z",
        lastSeenAt: "2026-04-01T10:05:10.000Z",
        primaryUrl: "https://example.com/story",
        primarySource: "example-wire",
        variantCount: 2,
        sourceCount: 2,
        sources: ["example-wire"],
        entities: [],
        tickerLinks: [],
        items: [],
      });
    });

    const story = await apiClient.getCloudNewsStory("story-1");

    expect(new URL(seenUrl).pathname).toBe("/news/story-1");
    expect(story.id).toBe("story-1");
  });
});
