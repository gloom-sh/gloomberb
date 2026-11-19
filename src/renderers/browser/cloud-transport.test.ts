import { afterEach, expect, test } from "bun:test";
import { browserCredentialedFetch, restoreBrowserCloudSession } from "./cloud-transport";
import { readBrowserSessionUser, rememberBrowserSessionUser } from "./session-cache";
import { NO_SESSION_COOKIE, SESSION_BINDING_HEADER } from "../../api-client/session-cookie";
import { apiClient, setCloudApiFetchTransport } from "../../api-client";
import { cloudDisplayScope } from "../../api-client/plan-access";
import { installTestWebSocket, verifiedUser } from "../../test-support/cloud-api";
import { withDeadline } from "../../utils/async-deadline";

test("a cached Pro user can only open under the cookie that established that user", () => {
  const records = new Map<string, string>();
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
    removeItem: (key: string) => { records.delete(key); },
  };
  const firstBinding = "a".repeat(64);
  const otherBinding = "b".repeat(64);
  const user = { id: "pro-user", plan: "pro", emailVerified: true, token: "never-store-this" } as const;
  rememberBrowserSessionUser(storage, firstBinding, user);
  expect(readBrowserSessionUser(storage, firstBinding)).toEqual({ id: user.id, plan: "pro", emailVerified: true });
  expect([...records.values()].join()).not.toContain(user.token);
  expect(readBrowserSessionUser(storage, otherBinding)).toBeNull();
  expect(readBrowserSessionUser(storage, NO_SESSION_COOKIE)).toBeNull();
  expect(readBrowserSessionUser(storage, null)).toBeNull();
  apiClient.setCookieSessionMode(true);
  try {
    apiClient.waitForCookieIdentity();
    expect(cloudDisplayScope()).toBeNull();
    apiClient.restoreCachedUser(readBrowserSessionUser(storage, firstBinding), false);
    expect(cloudDisplayScope()).toBe(JSON.stringify([user.id, true, true]));
    expect(apiClient.getVerifiedSessionIdentity()).toBeNull();
  } finally {
    apiClient.restoreCachedUser(null);
    apiClient.setCookieSessionMode(false);
  }
  rememberBrowserSessionUser(storage, firstBinding, { ...user, plan: "free" });
  expect(readBrowserSessionUser(storage, firstBinding)?.plan).toBe("free");
  rememberBrowserSessionUser(storage, firstBinding, null);
  expect(readBrowserSessionUser(storage, firstBinding)).toBeNull();
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("browser cloud transport uses host cookies without forwarding forbidden headers", async () => {
  let captured: RequestInit | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = init;
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await browserCredentialedFetch("https://api.gloom.sh/auth/get-session", {
    headers: { Cookie: "must-not-leak", Origin: "https://api.gloom.sh", Accept: "application/json" },
  });
  const headers = new Headers(captured?.headers);
  expect(captured?.credentials).toBe("include");
  expect(headers.has("Cookie")).toBe(false);
  expect(headers.has("Origin")).toBe(false);
  expect(headers.get("Accept")).toBe("application/json");
});

test("browser cloud transport plants session cookies before dropping the Cookie header", async () => {
  const planted: string[] = [];
  const previousDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: { cookie: string } }).document = {
    get cookie() {
      return planted.join("; ");
    },
    set cookie(value: string) {
      planted.push(value);
    },
  };
  const previousLocation = (globalThis as { location?: unknown }).location;
  (globalThis as { location?: { protocol: string } }).location = { protocol: "https:" };

  globalThis.fetch = (async () => {
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await browserCredentialedFetch("https://api.gloom.sh/auth/get-session", {
      headers: {
        Cookie: "__Secure-gloomberb.session_token=signed-token.value; gloomberb.session_token=signed-token.value",
      },
    });
    expect(planted).toEqual([
      "__Secure-gloomberb.session_token=signed-token.value; Path=/; SameSite=Lax; Secure",
      "gloomberb.session_token=signed-token.value; Path=/; SameSite=Lax; Secure",
    ]);
  } finally {
    if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = previousDocument;
    if (previousLocation === undefined) delete (globalThis as { location?: unknown }).location;
    else (globalThis as { location?: unknown }).location = previousLocation;
  }
});

const origin = "https://web-session.test";
const sessionUrl = `${origin}/api/auth/get-session`;
const sessionBinding = "c".repeat(64);
const proUser = { ...verifiedUser, plan: "pro" } as const;

function sessionResponse(user: typeof proUser | null, status = 200): Response {
  const response = Response.json(user ? { user } : null, { status, headers: user ? { [SESSION_BINDING_HEADER]: sessionBinding } : {} });
  Object.defineProperty(response, "url", { value: sessionUrl });
  return response;
}

async function withBrowserSession(run: (storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) => Promise<void>): Promise<void> {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const globals = { localStorage: storage, location: { origin }, document: { querySelector: () => ({ content: sessionBinding }) } };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true });
  const socket = globalThis.WebSocket;
  installTestWebSocket();
  apiClient.setCookieSessionMode(true);
  setCloudApiFetchTransport((url, init) => browserCredentialedFetch(`${origin}/api${new URL(url).pathname}`, init));
  try {
    await run(storage);
  } finally {
    apiClient.dispose();
    apiClient.setSessionToken(null);
    apiClient.setWebSocketToken(null);
    apiClient.setCookieSessionMode(false);
    setCloudApiFetchTransport(null);
    globalThis.WebSocket = socket;
    for (const name of Object.keys(globals)) {
      const descriptor = previous[name as keyof typeof globalThis];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test.each(["device poll", "password reset email", "sign-out"] as const)("a pending get-session display write across %s", async (operation) => {
  await withBrowserSession(async (storage) => {
    const answer = Promise.withResolvers<Response>();
    globalThis.fetch = (async (url: string) => url === sessionUrl ? answer.promise : Response.json({ status: "pending" })) as typeof fetch;
    const pending = browserCredentialedFetch(sessionUrl);
    if (operation === "device poll") await apiClient.pollDeviceSignIn("synthetic-device-code");
    else if (operation === "password reset email") await apiClient.requestPasswordReset("test@example.invalid");
    else await apiClient.signOut();
    answer.resolve(sessionResponse(proUser));
    await pending;
    expect(readBrowserSessionUser(storage, sessionBinding)?.id).toBe(operation === "sign-out" ? undefined : proUser.id);
  });
});

test.each(["5xx", "offline", "timeout"] as const)("an inconclusive web boot (%s) releases panes and recovers the session", async (failure) => {
  await withBrowserSession(async () => {
    let reads = 0;
    const held = Promise.withResolvers<Response>();
    const recovered = Promise.withResolvers<void>();
    const stop = apiClient.subscribeCurrentUser(() => {
      if (apiClient.getCurrentUser()?.id === proUser.id) recovered.resolve();
    });
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (url !== sessionUrl) {
        expect(init.credentials).toBe("omit");
        return Response.json({});
      }
      expect(init.credentials).toBe("include");
      reads += 1;
      if (reads !== 1) return sessionResponse(proUser);
      if (failure === "timeout") return held.promise;
      if (failure === "offline") throw new TypeError("Failed to fetch");
      return sessionResponse(null, 500);
    }) as typeof fetch;
    try {
      await restoreBrowserCloudSession(failure === "timeout" ? 1 : 500);
      expect(apiClient.isDisplayScopePending()).toBe(false);
      expect(cloudDisplayScope()).toBe(JSON.stringify([null, false, false]));
      expect(reads).toBe(1);
      await browserCredentialedFetch(`${origin}/api/market/quote`);
      if (failure === "timeout") held.resolve(sessionResponse(null, 500));
      await withDeadline(recovered.promise, 2_500, "Session did not retry");
      expect(reads).toBe(2);
      expect(apiClient.isCookieIdentityUnavailable()).toBe(false);
      expect(cloudDisplayScope()).toBe(JSON.stringify([proUser.id, true, true]));
    } finally {
      stop();
    }
  });
});

test("a same-origin get-session 401 discards the cached user without a binding header", async () => {
  await withBrowserSession(async (storage) => {
    rememberBrowserSessionUser(storage, sessionBinding, proUser);
    globalThis.fetch = (async () => sessionResponse(null, 401)) as typeof fetch;
    await restoreBrowserCloudSession();
    await apiClient.getSession();
    expect(apiClient.getCurrentUser()).toBeNull();
    expect(readBrowserSessionUser(storage, sessionBinding)).toBeNull();
    expect(apiClient.isDisplayScopePending()).toBe(false);
  });
});
