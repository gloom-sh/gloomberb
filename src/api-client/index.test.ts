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
  apiClient.setCookieSessionMode(false);
  jest.useRealTimers();
});

describe("apiClient auth cookies", () => {
  test("accepts a browser-managed api.gloom.sh cookie without exposing its value", async () => {
    apiClient.setCookieSessionMode(true);
    setCloudApiFetchTransport(mockFetch(() => createResponse({ user: verifiedUser })));

    await expect(apiClient.signIn("test@example.com", "password")).resolves.toEqual(verifiedUser);
    expect(apiClient.getSessionToken()).toBeNull();
    expect(apiClient.isVerified()).toBe(true);
  });

  test("reports signed-in from the restored user when the cookie hides the raw token", async () => {
    apiClient.setCookieSessionMode(true);
    setCloudApiFetchTransport(mockFetch(() => createResponse({ user: verifiedUser })));

    expect(apiClient.isSignedIn()).toBe(false);
    await apiClient.signIn("test@example.com", "password");
    expect(apiClient.getSessionToken()).toBeNull();
    expect(apiClient.isSignedIn()).toBe(true);
  });

  test("coalesces anonymous browser session checks and remembers the result", async () => {
    apiClient.setCookieSessionMode(true);
    let requests = 0;
    let finishRequest!: () => void;
    setCloudApiFetchTransport(async () => {
      requests += 1;
      await new Promise<void>((resolve) => { finishRequest = resolve; });
      return createResponse({ user: null });
    });

    const checks = [
      apiClient.ensureVerifiedSession(),
      apiClient.ensureVerifiedSession(),
      apiClient.ensureVerifiedSession(),
    ];
    expect(requests).toBe(1);
    finishRequest();

    await expect(Promise.all(checks)).resolves.toEqual([null, null, null]);
    await expect(apiClient.ensureVerifiedSession()).resolves.toBeNull();
    expect(requests).toBe(1);
  });

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

  test("creates a browser handoff with the captured session instead of exposing it in the URL", async () => {
    let requestedUrl = "";
    let requestedCookie: string | null = null;
    apiClient.setSessionToken("desktop-session-token");
    globalThis.fetch = mockFetch(async (input: Request | string | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedCookie = new Headers(init?.headers).get("Cookie");
      return createResponse({
        url: "https://api.gloom.sh/cloud/auth/browser-handoff?token=opaque-one-time-token",
      });
    });

    const handoff = await apiClient.createBrowserHandoff();

    expect(new URL(requestedUrl).pathname).toBe("/cloud/auth/browser-handoff");
    expect(requestedCookie).toBe(
      "__Secure-gloomberb.session_token=desktop-session-token; gloomberb.session_token=desktop-session-token",
    );
    expect(handoff.url).toContain("token=opaque-one-time-token");
    expect(handoff.url).not.toContain("desktop-session-token");
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

  test("reconnects and replays quote targets when market entitlement changes", () => {
    const sockets = installTestWebSocket();
    apiClient.setSessionToken("session-token");
    apiClient.restoreCachedUser({ ...verifiedUser, plan: "free" });
    const target = {
      symbol: "AAPL260731C00110000",
      exchange: "OPTIONS",
      surface: "options" as const,
      visible: true,
    };
    const unsubscribe = apiClient.subscribeQuotes([target], () => {});
    sockets[0]!.open();

    apiClient.restoreCachedUser({ ...verifiedUser, plan: "pro" });

    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closeCalls).toBe(1);
    expect(sockets[1]!.url).toContain("token=session-token");
    sockets[1]!.open();
    expect(sockets[1]!.sent).toContainEqual({
      type: "market.subscribe",
      symbols: [target],
    });
    unsubscribe();
  });

  test("serializes and dispatches compact OCC option quote targets", () => {
    const sockets = installTestWebSocket();
    const seen: Array<{ symbol: string; dataSource: string | undefined }> = [];
    const unsubscribe = apiClient.subscribeQuotes(
      [
        {
          symbol: "AAPL260731C00110000",
          exchange: "OPTIONS",
          surface: "options",
          visible: true,
          selected: true,
          weight: 100,
        },
      ],
      (target, quote) => {
        seen.push({ symbol: target.symbol, dataSource: quote.dataSource });
      },
    );
    const socket = sockets[0]!;
    socket.open();

    expect(socket.sent).toContainEqual({
      type: "market.subscribe",
      symbols: [
        {
          symbol: "AAPL260731C00110000",
          exchange: "OPTIONS",
          surface: "options",
          visible: true,
          selected: true,
          weight: 100,
        },
      ],
    });

    socket.receive({
      type: "market.quote",
      symbol: "AAPL260731C00110000",
      exchange: "OPTIONS",
      quote: {
        symbol: "AAPL260731C00110000",
        providerId: "gloomberb-cloud",
        price: 2.5,
        currency: "USD",
        change: 0,
        changePercent: 0,
        lastUpdated: 1_800_000_000_000,
        dataSource: "live",
      },
    });

    expect(seen).toEqual([
      {
        symbol: "AAPL260731C00110000",
        dataSource: "live",
      },
    ]);
    unsubscribe();
  });

  test("preserves quote delivery and stale metadata from websocket messages", () => {
    const sockets = installTestWebSocket();
    const seen: Array<{ delivery?: string; stale?: boolean }> = [];
    const unsubscribe = apiClient.subscribeQuotes(
      [{ symbol: "AAPL260731C00110000", exchange: "OPTIONS" }],
      (_target, quote) => {
        seen.push({ delivery: quote.delivery, stale: quote.stale });
      },
    );
    const socket = sockets[0]!;
    socket.open();

    socket.receive({
      type: "market.quote",
      symbol: "AAPL260731C00110000",
      exchange: "OPTIONS",
      delivery: "poll",
      stale: true,
      quote: {
        symbol: "AAPL260731C00110000",
        providerId: "gloomberb-cloud",
        price: 2.5,
        currency: "USD",
        change: 0,
        changePercent: 0,
        lastUpdated: 1_800_000_000_000,
        dataSource: "live",
      },
    });

    expect(seen).toEqual([{ delivery: "poll", stale: true }]);
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

  test("unsubscribes removed quote targets before subscribing replacements", () => {
    jest.useFakeTimers();
    const sockets = installTestWebSocket();
    const oldTargets = Array.from({ length: 16 }, (_, index) => ({
      symbol: `OPT${index}`,
      exchange: "OPTIONS",
    }));
    const newTargets = Array.from({ length: 16 }, (_, index) => ({
      symbol: `OPT${index + 2}`,
      exchange: "OPTIONS",
    }));
    const unsubscribeOld = apiClient.subscribeQuotes(oldTargets, () => {});
    const socket = sockets[0]!;
    socket.open();
    flushQuoteSubscriptionUpdates();
    socket.sent.length = 0;

    const unsubscribeNew = apiClient.subscribeQuotes(newTargets, () => {});
    unsubscribeOld();
    flushQuoteSubscriptionUpdates();

    expect(socket.sent.map((message) => (message as { type: string }).type)).toEqual([
      "market.unsubscribe",
      "market.subscribe",
    ]);
    expect(socket.sent[0]).toMatchObject({
      symbols: [{ symbol: "OPT0" }, { symbol: "OPT1" }],
    });
    expect(socket.sent[1]).toMatchObject({
      symbols: [{ symbol: "OPT16" }, { symbol: "OPT17" }],
    });

    unsubscribeNew();
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

describe("apiClient scanner subscriptions", () => {
  test("subscribes once for many panes, fans out, replays the snapshot, and unsubscribes last", () => {
    const sockets = installTestWebSocket();
    const first: unknown[] = [];
    const second: unknown[] = [];

    const unsubscribeFirst = apiClient.subscribeScanner("hilo", (event) => first.push(event));
    const socket = sockets[0]!;
    socket.open();
    expect(socket.sent).toContainEqual({ type: "scanner.subscribe", scanner: "hilo" });

    const payload = {
      status: "live",
      asOf: 1,
      windows: { s30: { highs: 1, lows: 0 }, m1: { highs: 2, lows: 1 }, m5: { highs: 3, lows: 2 } },
      highs: [],
      lows: [],
    };
    socket.receive({ type: "scanner.hilo", ...payload });

    // A second pane must not open a second upstream subscription, and must not
    // wait a tick for its first frame.
    const subscribeCount = () => socket.sent.filter((message: any) => message.type === "scanner.subscribe").length;
    const before = subscribeCount();
    const unsubscribeSecond = apiClient.subscribeScanner("hilo", (event) => second.push(event));
    expect(subscribeCount()).toBe(before);
    expect(second).toEqual([{ type: "data", payload }]);

    socket.receive({ type: "scanner.hilo", ...payload, asOf: 2 });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);

    unsubscribeFirst();
    expect(socket.sent).not.toContainEqual({ type: "scanner.unsubscribe", scanner: "hilo" });
    unsubscribeSecond();
    expect(socket.sent).toContainEqual({ type: "scanner.unsubscribe", scanner: "hilo" });
  });

  test("replays scanner subscriptions after a reconnect and surfaces denials", () => {
    const sockets = installTestWebSocket();
    const seen: unknown[] = [];
    const unsubscribe = apiClient.subscribeScanner("flow", (event) => seen.push(event));

    const socket = sockets[0]!;
    socket.open();
    socket.receive({ type: "scanner.denied", scanner: "flow", reason: "pro_required" });
    expect(seen).toEqual([{ type: "denied", reason: "pro_required" }]);

    jest.useFakeTimers();
    socket.closeWith({ code: 1006, reason: "network" });
    jest.runAllTimers();
    const reconnected = sockets[1]!;
    reconnected.open();
    expect(reconnected.sent).toContainEqual({ type: "scanner.subscribe", scanner: "flow" });

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
