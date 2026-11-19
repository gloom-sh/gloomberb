import { afterEach, expect, test } from "bun:test";
import { browserCredentialedFetch } from "./cloud-transport";
import { readBrowserSessionUser, rememberBrowserSessionUser } from "./session-cache";
import { NO_SESSION_COOKIE } from "../../api-client/session-cookie";
import { apiClient } from "../../api-client";
import { cloudDisplayScope } from "../../api-client/plan-access";

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
