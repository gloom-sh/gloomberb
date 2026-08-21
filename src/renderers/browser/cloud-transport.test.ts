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

test("browser boot restores an existing Gloom Cloud cookie session", async () => {
  const getSession = spyOn(apiClient, "getSession").mockResolvedValue(null);
  await restoreBrowserCloudSession();
  expect(getSession).toHaveBeenCalledTimes(1);
  getSession.mockRestore();
});
