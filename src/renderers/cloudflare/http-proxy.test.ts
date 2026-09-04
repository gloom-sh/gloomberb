import { describe, expect, test } from "bun:test";
import { handleHttpProxy, validateProxyTarget } from "./http-proxy";

const SESSION_COOKIE = "__Secure-gloomberb.session_token=abc123";

function proxyRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request("https://term.gloom.sh/http-proxy", {
    method: "POST",
    headers: { cookie: SESSION_COOKIE, ...(init.headers as Record<string, string> ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
}

describe("proxy target validation", () => {
  test("allows an allowlisted host and its subdomains", () => {
    expect(validateProxyTarget("https://substack.com/api/v1/reader/feed")).toHaveProperty("url");
    expect(validateProxyTarget("https://example.substack.com/api/v1/posts")).toHaveProperty("url");
  });

  test("refuses a host that merely ends with an allowlisted name", () => {
    // "evilsubstack.com" ends with "substack.com" as a string but is a
    // different registrable domain, so suffix matching has to be on a label.
    expect(validateProxyTarget("https://evilsubstack.com/x")).toMatchObject({ status: 403 });
  });

  test.each([
    ["http://substack.com/x", "plain http"],
    ["https://user:pass@substack.com/x", "credentials in the URL"],
    ["https://substack.com:8443/x", "a non-default port"],
    ["https://169.254.169.254/latest/meta-data", "an IP literal"],
    ["https://localhost/x", "localhost"],
    ["https://api.github.com/x", "a host that is not allowlisted"],
  ])("refuses %s (%s)", (url) => {
    const result = validateProxyTarget(url);

    expect(result).not.toHaveProperty("url");
    expect((result as { status: number }).status).toBeGreaterThanOrEqual(400);
  });
});

describe("proxy request handling", () => {
  test("forwards only the envelope, never the caller's session cookie", async () => {
    // The browser attaches the Gloomberb session to this same-origin POST.
    // Passing it upstream would hand a third party the user's session.
    let seen: Request | undefined;
    const response = await handleHttpProxy(
      proxyRequest({
        url: "https://substack.com/api/v1/reader/feed",
        init: { headers: { cookie: "substack.sid=plugin-owned", "user-agent": "Gloomberb" } },
      }),
      (async (input: Request | string | URL, init?: RequestInit) => {
        seen = new Request(input as never, init);
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    );

    expect(response.status).toBe(200);
    expect(seen?.headers.get("cookie")).toBe("substack.sid=plugin-owned");
    expect(seen?.headers.get("cookie")).not.toContain("gloomberb.session_token");
    expect(seen?.headers.get("user-agent")).toBe("Gloomberb");
  });

  test("returns set-cookie in the envelope instead of as a header", async () => {
    // A real Set-Cookie here would let a third party set cookies on the
    // Gloomberb origin.
    const response = await handleHttpProxy(
      proxyRequest({ url: "https://substack.com/api/v1/login", init: { method: "POST", body: "{}" } }),
      (async () => new Response("{}", {
        status: 200,
        headers: { "set-cookie": "substack.sid=granted; Path=/; HttpOnly" },
      })) as typeof fetch,
    );
    const envelope = await response.json() as { setCookie: string[]; headers: Record<string, string> };

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(envelope.setCookie[0]).toContain("substack.sid=granted");
    expect(envelope.headers["set-cookie"]).toBeUndefined();
  });

  test("requires a session cookie", async () => {
    const response = await handleHttpProxy(
      new Request("https://term.gloom.sh/http-proxy", {
        method: "POST",
        body: JSON.stringify({ url: "https://substack.com/x" }),
      }),
      (async () => new Response("nope")) as typeof fetch,
    );

    expect(response.status).toBe(401);
  });

  test("refuses a cross-origin caller", async () => {
    const response = await handleHttpProxy(
      proxyRequest({ url: "https://substack.com/x" }, { headers: { origin: "https://evil.example" } }),
      (async () => new Response("nope")) as typeof fetch,
    );

    expect(response.status).toBe(403);
  });

  test("reports an upstream timeout as a gateway error rather than throwing", async () => {
    const response = await handleHttpProxy(
      proxyRequest({ url: "https://substack.com/slow" }),
      (async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }) as typeof fetch,
    );

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("timed out") });
  });
});
