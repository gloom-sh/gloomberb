import { describe, expect, test } from "bun:test";
import { handleRequest, SECURITY_HEADERS, type WorkerEnv } from "./worker";

function fixture() {
  const requests: Request[] = [];
  const env: WorkerEnv = {
    ASSETS: {
      async fetch(request) {
        requests.push(request);
        return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
      },
    },
  };
  return { env, requests };
}

describe("static Cloudflare host", () => {
  test("reports health without invoking static assets", async () => {
    const { env, requests } = fixture();
    const response = await handleRequest(new Request("https://term.example/health"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(requests).toHaveLength(0);
  });

  test("serves app assets with an enforced CSP and security headers", async () => {
    const { env } = fixture();
    const response = await handleRequest(new Request("https://term.example/"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["content-security-policy"]);
    expect(response.headers.has("content-security-policy-report-only")).toBe(false);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("rewrites only valid public share paths to the slim document", async () => {
    const { env, requests } = fixture();
    const response = await handleRequest(new Request("https://term.example/s/0123456789abcdef0123456789abcdef"), env);
    expect(new URL(requests[0]!.url).pathname).toBe("/share.html");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  });

  test("serves the Apple app site association without touching static assets", async () => {
    const { env, requests } = fixture();
    const response = await handleRequest(
      new Request("https://term.example/.well-known/apple-app-site-association"),
      env,
    );

    // Apple's fetcher accepts none of: a redirect, an HTML body, a 404. Any of
    // those disables universal links silently, so pin the exact contract.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(requests).toHaveLength(0);

    const body = (await response.json()) as {
      applinks: { details: { appIDs: string[]; components: { "/": string }[] }[] };
    };
    const detail = body.applinks.details[0]!;
    expect(detail.appIDs).toEqual(["3XQML3UV65.sh.gloom.companion"]);
    // Only share links are claimed; everything else must stay in the browser.
    expect(detail.components[0]!["/"]).toBe("/s/*");
  });

  test("claims exactly the share paths the worker itself rewrites", async () => {
    const { env } = fixture();
    const response = await handleRequest(
      new Request("https://term.example/.well-known/apple-app-site-association"),
      env,
    );
    const body = (await response.json()) as {
      applinks: { details: { components: { "/": string }[] }[] };
    };
    const claimed = body.applinks.details[0]!.components[0]!["/"];

    // A real share id must match the pattern advertised to Apple, otherwise the
    // app is claiming links the site does not serve, or missing ones it does.
    const shareId = "0123456789abcdef0123456789abcdef";
    const pattern = new RegExp(`^${claimed.replace("*", ".*")}$`);
    expect(pattern.test(`/s/${shareId}`)).toBe(true);
    expect(pattern.test("/settings")).toBe(false);
  });

  test("proxies only the same-origin API path to api.gloom.sh", async () => {
    const { env, requests } = fixture();
    let upstream: Request | undefined;
    const response = await handleRequest(new Request("https://term.example/api/chat/channels/everyone/messages?limit=1", {
      method: "POST",
      headers: {
        Cookie: "session=browser-cookie",
        Origin: "https://term.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "hello" }),
    }), env, async (request) => {
      upstream = request;
      return Response.json({ ok: true });
    });

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(0);
    expect(upstream?.url).toBe("https://api.gloom.sh/chat/channels/everyone/messages?limit=1");
    expect(upstream?.method).toBe("POST");
    expect(upstream?.headers.get("cookie")).toBe("session=browser-cookie");
    expect(upstream?.headers.get("origin")).toBe("https://term.example");
    expect(await upstream?.text()).toBe('{"content":"hello"}');
  });

  test("rejects cross-origin API requests before proxying", async () => {
    const { env } = fixture();
    let proxied = false;
    const response = await handleRequest(new Request("https://term.example/api/auth/sign-out", {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    }), env, async () => {
      proxied = true;
      return new Response();
    });
    expect(response.status).toBe(403);
    expect(proxied).toBe(false);
  });

  test("rejects every non-API mutation without invoking assets or outbound fetch", async () => {
    const { env, requests } = fixture();
    const response = await handleRequest(new Request("https://term.example/shares", {
      method: "POST",
      headers: { Origin: "https://term.example" },
    }), env);
    expect(response.status).toBe(405);
    expect(requests).toHaveLength(0);
  });
});
