import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import {
  browserCredentialedFetch,
  restoreBrowserCloudSession,
} from "./cloud-transport";

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

test("browser boot restores an existing Gloom Cloud cookie session", async () => {
  const getSession = spyOn(apiClient, "getSession").mockResolvedValue(null);
  await restoreBrowserCloudSession();
  expect(getSession).toHaveBeenCalledTimes(1);
  getSession.mockRestore();
});
