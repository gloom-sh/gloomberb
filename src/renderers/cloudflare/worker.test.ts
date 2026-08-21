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
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("rewrites only valid public share paths to the slim document", async () => {
    const { env, requests } = fixture();
    const response = await handleRequest(new Request("https://term.example/s/0123456789abcdef0123456789abcdef"), env);
    expect(new URL(requests[0]!.url).pathname).toBe("/share.html");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  });

  test("rejects every mutation without invoking assets or outbound fetch", async () => {
    const { env, requests } = fixture();
    const response = await handleRequest(new Request("https://term.example/shares", {
      method: "POST",
      headers: { Origin: "https://term.example" },
    }), env);
    expect(response.status).toBe(405);
    expect(requests).toHaveLength(0);
  });
});
