import { describe, expect, test } from "bun:test";
import { handleHttpProxy, validateProxyTarget } from "./http-proxy";
import { createProxySessionGate, type ProxySessionGateOptions } from "./proxy-session";

const ORIGIN = "https://term.gloom.sh";
const SESSION_URL = "https://api.gloom.sh/auth/get-session";
const SESSION_COOKIE = "__Secure-gloomberb.session_token=abc123.signature";

// The real allowlist is generated from what bundled plugins declare. These
// tests are about the guardrails, so they pin one example host.
const HOSTS = ["substack.com"];

type Upstream = (url: URL, init: RequestInit) => Response | Promise<Response>;

function proxyRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/http-proxy`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie: SESSION_COOKIE, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The API's answer for a live session, and for anything else (an empty 200). */
const LIVE_SESSION = () => Response.json({ user: { id: "user_1" }, session: { id: "session_1" } });
const NO_SESSION = () => new Response(null, { status: 200 });

/** A live session for whichever user the forwarded `session_token` value names, like `user_a.sig`. */
const SESSION_PER_TOKEN = (request: Request) => {
  const token = /session_token=([^.;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  return Response.json({ user: { id: token }, session: { id: `session_${token}` } });
};

function asUser(token: string, extra = ""): Record<string, string> {
  return { cookie: `__Secure-gloomberb.session_token=${token}${extra}` };
}

/**
 * A proxy wired to fakes: `api` answers the session check, `upstream` plays
 * the third party. Every call to either is recorded.
 */
function harness(options: {
  upstream?: Upstream;
  api?: (request: Request) => Response | Promise<Response>;
  gate?: Partial<ProxySessionGateOptions>;
} = {}) {
  let clock = 1_000_000;
  const apiCalls: Request[] = [];
  const upstreamCalls: { url: URL; init: RequestInit }[] = [];
  const sessions = createProxySessionGate({ sessionUrl: SESSION_URL, now: () => clock, ...options.gate });
  const fetchApi = async (request: Request) => {
    apiCalls.push(request);
    return (options.api ?? LIVE_SESSION)(request);
  };
  const fetchUpstream = (async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    upstreamCalls.push({ url, init });
    return (options.upstream ?? (() => Response.json([])))(url, init);
  }) as unknown as typeof fetch;

  return {
    apiCalls,
    upstreamCalls,
    advance(ms: number) {
      clock += ms;
    },
    send(request: Request) {
      return handleHttpProxy(request, { sessions, fetchApi, fetchUpstream, hosts: HOSTS });
    },
  };
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

/** A body that never ends, counting how much of it was pulled. */
function endlessBody(chunkBytes: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe("proxy target validation", () => {
  test("allows an allowlisted host and its subdomains", () => {
    expect(validateProxyTarget("https://substack.com/api/v1/reader/feed", HOSTS)).toHaveProperty("url");
    expect(validateProxyTarget("https://example.substack.com/api/v1/posts", HOSTS)).toHaveProperty("url");
  });

  test("refuses a host that merely ends with an allowlisted name", () => {
    // "evilsubstack.com" ends with "substack.com" as a string but is a
    // different registrable domain, so suffix matching has to be on a label.
    expect(validateProxyTarget("https://evilsubstack.com/x", HOSTS)).toMatchObject({ status: 403 });
  });

  test.each([
    ["http://substack.com/x", "plain http"],
    ["https://user:pass@substack.com/x", "credentials in the URL"],
    ["https://substack.com:8443/x", "a non-default port"],
    ["https://169.254.169.254/latest/meta-data", "an IP literal"],
    ["https://localhost/x", "localhost"],
    ["https://api.github.com/x", "a host that is not allowlisted"],
  ])("refuses %s (%s)", (url) => {
    const result = validateProxyTarget(url, HOSTS);

    expect(result).not.toHaveProperty("url");
    expect((result as { status: number }).status).toBeGreaterThanOrEqual(400);
  });
});

describe("proxy request handling", () => {
  test("forwards only the envelope, never the caller's session cookie", async () => {
    // The browser attaches the Gloomberb session to this same-origin POST.
    // Passing it upstream would hand a third party the user's session.
    const proxy = harness();
    const response = await proxy.send(proxyRequest({
      url: "https://substack.com/api/v1/reader/feed",
      init: { headers: { cookie: "substack.sid=plugin-owned", "user-agent": "Gloomberb" } },
    }));
    const sent = new Headers(proxy.upstreamCalls[0]?.init.headers);

    expect(response.status).toBe(200);
    expect(sent.get("cookie")).toBe("substack.sid=plugin-owned");
    expect(sent.get("cookie")).not.toContain("gloomberb.session_token");
    expect(sent.get("user-agent")).toBe("Gloomberb");
  });

  test("returns set-cookie in the envelope instead of as a header", async () => {
    // A real Set-Cookie here would let a third party set cookies on the
    // Gloomberb origin.
    const proxy = harness({
      upstream: () => new Response("{}", {
        status: 200,
        headers: { "set-cookie": "substack.sid=granted; Path=/; HttpOnly" },
      }),
    });
    const response = await proxy.send(proxyRequest({
      url: "https://substack.com/api/v1/login",
      init: { method: "POST", body: "{}" },
    }));
    const envelope = await response.json() as { setCookie: string[]; headers: Record<string, string> };

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(envelope.setCookie[0]).toContain("substack.sid=granted");
    expect(envelope.headers["set-cookie"]).toBeUndefined();
  });

  test("refuses a cross-origin caller", async () => {
    const proxy = harness();
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/x" }, { origin: "https://evil.example" }));

    expect(response.status).toBe(403);
    expect(proxy.apiCalls).toHaveLength(0);
  });

  test("refuses a caller that sends no Origin", async () => {
    // Browsers always send Origin on a POST, so only a non-browser client
    // reaches the proxy without one.
    const proxy = harness();
    const response = await proxy.send(new Request(`${ORIGIN}/http-proxy`, {
      method: "POST",
      headers: { cookie: SESSION_COOKIE },
      body: JSON.stringify({ url: "https://substack.com/x" }),
    }));

    expect(response.status).toBe(403);
    expect(proxy.apiCalls).toHaveLength(0);
    expect(proxy.upstreamCalls).toHaveLength(0);
  });

  test("reports an upstream timeout as a gateway error rather than throwing", async () => {
    const proxy = harness({
      upstream: () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
    });
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/slow" }));

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("timed out") });
  });

  test("refuses an oversized request envelope before parsing it", async () => {
    const proxy = harness();
    const response = await proxy.send(proxyRequest({
      url: "https://substack.com/x",
      init: { method: "POST", body: "a".repeat(1024 * 1024 + 1) },
    }));

    expect(response.status).toBe(413);
    expect(proxy.upstreamCalls).toHaveLength(0);
  });

  test("answers a non-object JSON body with a 400 instead of throwing", async () => {
    const proxy = harness();
    const response = await proxy.send(proxyRequest("null"));

    expect(response.status).toBe(400);
  });
});

describe("proxy session check", () => {
  test("requires a session cookie, without asking the API", async () => {
    const proxy = harness();
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/x" }, { cookie: "other=1" }));

    expect(response.status).toBe(401);
    expect(proxy.apiCalls).toHaveLength(0);
    expect(proxy.upstreamCalls).toHaveLength(0);
  });

  test("refuses a session cookie the API does not recognize", async () => {
    // Having a cookie with the right name is not a session.
    const proxy = harness({ api: NO_SESSION });
    const response = await proxy.send(proxyRequest(
      { url: "https://substack.com/x" },
      { cookie: "__Secure-gloomberb.session_token=made-up" },
    ));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Sign in") });
    expect(proxy.upstreamCalls).toHaveLength(0);
  });

  test("does not remember a rejected session, so signing in again works at once", async () => {
    const proxy = harness({ api: NO_SESSION });
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }));
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }));

    expect(proxy.apiCalls).toHaveLength(2);
  });

  test("sends the API only the session cookies", async () => {
    const proxy = harness();
    await proxy.send(proxyRequest(
      { url: "https://substack.com/x" },
      { cookie: `ph_session=analytics; ${SESSION_COOKIE}; __Secure-gloomberb.dont_remember=true; theme=dark` },
    ));
    const check = proxy.apiCalls[0]!;

    expect(check.url).toBe(SESSION_URL);
    expect(check.method).toBe("GET");
    expect(check.headers.get("cookie")).toBe(`${SESSION_COOKIE}; __Secure-gloomberb.dont_remember=true`);
  });

  test("accepts a live session and checks it once for a burst of requests", async () => {
    const proxy = harness();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => proxy.send(proxyRequest({ url: "https://substack.com/x" }))),
    );
    await proxy.send(proxyRequest({ url: "https://substack.com/y" }));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(proxy.apiCalls).toHaveLength(1);
    expect(proxy.upstreamCalls).toHaveLength(6);
  });

  test("stops waiting on another request's check that never settles", async () => {
    // Workers drop a promise's continuations when the request that started it
    // ends, for instance when a plugin aborts its fetch mid-check. Requests
    // waiting on that check must not hang with it.
    let calls = 0;
    const proxy = harness({
      gate: { checkTimeoutMs: 20 },
      api: () => (++calls === 1 ? new Promise<Response>(() => {}) : LIVE_SESSION()),
    });
    void proxy.send(proxyRequest({ url: "https://substack.com/abandoned" }));
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/x" }));

    expect(response.status).toBe(200);
    expect(proxy.apiCalls).toHaveLength(2);
  });

  test("checks the session again once the cached answer expires", async () => {
    const proxy = harness();
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }));
    proxy.advance(59_000);
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }));
    expect(proxy.apiCalls).toHaveLength(1);

    proxy.advance(2_000);
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }));
    expect(proxy.apiCalls).toHaveLength(2);
  });

  test("caches per cookie value, so another session is checked on its own", async () => {
    const proxy = harness({
      api: (request) => (request.headers.get("cookie") === SESSION_COOKIE ? LIVE_SESSION() : NO_SESSION()),
    });
    const live = await proxy.send(proxyRequest({ url: "https://substack.com/x" }));
    const fake = await proxy.send(proxyRequest(
      { url: "https://substack.com/x" },
      { cookie: "__Secure-gloomberb.session_token=guessed" },
    ));

    expect(live.status).toBe(200);
    expect(fake.status).toBe(401);
    expect(proxy.apiCalls).toHaveLength(2);
  });

  test.each([
    ["an error status", () => new Response("upstream down", { status: 502 })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    ["a network failure", () => {
      throw new TypeError("fetch failed");
    }],
  ])("fails closed with a 503 when the API returns %s", async (_label, api) => {
    const proxy = harness({ api });
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/x" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("confirm your session") });
    expect(proxy.upstreamCalls).toHaveLength(0);
  });

  test("does not cache a failed check, so the next request tries again", async () => {
    let down = true;
    const proxy = harness({ api: () => (down ? new Response(null, { status: 500 }) : LIVE_SESSION()) });
    expect((await proxy.send(proxyRequest({ url: "https://substack.com/x" }))).status).toBe(503);

    down = false;
    expect((await proxy.send(proxyRequest({ url: "https://substack.com/x" }))).status).toBe(200);
    expect(proxy.apiCalls).toHaveLength(2);
  });

  test("rate limits a single user and lets them back in after the window", async () => {
    const proxy = harness({ gate: { requestsPerWindow: 2, windowMs: 60_000 } });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await proxy.send(proxyRequest({ url: "https://substack.com/x" }))).status);
    }
    const limited = await proxy.send(proxyRequest({ url: "https://substack.com/x" }));

    expect(statuses).toEqual([200, 200, 429]);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(proxy.upstreamCalls).toHaveLength(2);

    proxy.advance(60_000);
    expect((await proxy.send(proxyRequest({ url: "https://substack.com/x" }))).status).toBe(200);
  });

  test("counts every cookie variant of a session against one window", async () => {
    // The API reads only the token before the first "." and only whether
    // dont_remember is present, so these all reach the same session. Each one
    // is a separate cache entry, but none of them may start a fresh window.
    const proxy = harness({ gate: { requestsPerWindow: 3 } });
    const variants = [
      SESSION_COOKIE,
      "__Secure-gloomberb.session_token=abc123.other-signature",
      "__Secure-gloomberb.session_token=abc123",
      `${SESSION_COOKIE}; gloomberb.dont_remember=1`,
      `${SESSION_COOKIE}; gloomberb.dont_remember=2`,
      `${SESSION_COOKIE}; gloomberb.session_token=junk`,
    ];
    const statuses: number[] = [];
    for (const cookie of variants) {
      statuses.push((await proxy.send(proxyRequest({ url: "https://substack.com/x" }, { cookie }))).status);
    }

    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    expect(proxy.upstreamCalls).toHaveLength(3);
  });

  test("gives each user their own window", async () => {
    const proxy = harness({ api: SESSION_PER_TOKEN, gate: { requestsPerWindow: 1 } });
    const first = await proxy.send(proxyRequest({ url: "https://substack.com/x" }, asUser("user_a")));
    const again = await proxy.send(proxyRequest({ url: "https://substack.com/x" }, asUser("user_a")));
    const other = await proxy.send(proxyRequest({ url: "https://substack.com/x" }, asUser("user_b")));

    expect([first.status, again.status, other.status]).toEqual([200, 429, 200]);
  });

  test("stops one user's cookie variants from pushing others out of the cache", async () => {
    const proxy = harness({ api: SESSION_PER_TOKEN, gate: { maxEntries: 4, maxEntriesPerUser: 2 } });
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }, asUser("user_b")));
    for (let i = 0; i < 10; i += 1) {
      await proxy.send(proxyRequest({ url: "https://substack.com/x" }, asUser("user_a", `.variant${i}`)));
    }
    proxy.apiCalls.length = 0;

    // user_b is still cached; of user_a's variants only the newest two are.
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }, asUser("user_b")));
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }, asUser("user_a", ".variant9")));
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }, asUser("user_a", ".variant8")));
    expect(proxy.apiCalls).toHaveLength(0);

    await proxy.send(proxyRequest({ url: "https://substack.com/x" }, asUser("user_a", ".variant7")));
    expect(proxy.apiCalls).toHaveLength(1);
  });

  test("keeps the cache bounded", async () => {
    const proxy = harness({ api: SESSION_PER_TOKEN, gate: { maxEntries: 2 } });
    for (const token of ["a", "b", "c"]) {
      await proxy.send(proxyRequest({ url: "https://substack.com/x" }, { cookie: `gloomberb.session_token=${token}` }));
    }
    // "a" was the oldest entry and made room for "c", so it is checked again.
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }, { cookie: "gloomberb.session_token=c" }));
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }, { cookie: "gloomberb.session_token=a" }));

    expect(proxy.apiCalls.map((request) => request.headers.get("cookie"))).toEqual([
      "gloomberb.session_token=a",
      "gloomberb.session_token=b",
      "gloomberb.session_token=c",
      "gloomberb.session_token=a",
    ]);
  });
});

describe("proxy redirects", () => {
  test("never lets fetch follow a redirect on its own", async () => {
    const proxy = harness();
    await proxy.send(proxyRequest({ url: "https://substack.com/x" }));

    expect(proxy.upstreamCalls[0]?.init.redirect).toBe("manual");
  });

  test("follows a redirect to an allowlisted host", async () => {
    const proxy = harness({
      upstream: (url) => (url.hostname === "substack.com"
        ? redirect(302, "https://cdn.substack.com/feed?page=2")
        : Response.json({ moved: true })),
    });
    const response = await proxy.send(proxyRequest({
      url: "https://substack.com/feed",
      init: { headers: { cookie: "substack.sid=plugin-owned", authorization: "Bearer plugin", accept: "application/json" } },
    }));
    const envelope = await response.json() as { status: number; body: string };
    const second = new Headers(proxy.upstreamCalls[1]?.init.headers);

    expect(response.status).toBe(200);
    expect(envelope.status).toBe(200);
    expect(JSON.parse(envelope.body)).toEqual({ moved: true });
    expect(proxy.upstreamCalls.map((call) => call.url.href)).toEqual([
      "https://substack.com/feed",
      "https://cdn.substack.com/feed?page=2",
    ]);
    // Credentials the plugin set for one origin do not travel to another.
    expect(second.get("cookie")).toBeNull();
    expect(second.get("authorization")).toBeNull();
    expect(second.get("accept")).toBe("application/json");
  });

  test("resolves a relative Location against the current URL", async () => {
    const proxy = harness({
      upstream: (url) => (url.pathname === "/old" ? redirect(301, "/new?x=1") : Response.json({})),
    });
    await proxy.send(proxyRequest({ url: "https://substack.com/old" }));

    expect(proxy.upstreamCalls[1]?.url.href).toBe("https://substack.com/new?x=1");
  });

  test.each([
    ["a host that is not allowlisted", "https://evil.example/steal"],
    ["plain http on an allowlisted host", "http://substack.com/x"],
    ["an IP literal", "https://169.254.169.254/latest/meta-data"],
    ["credentials in the URL", "https://user:pass@substack.com/x"],
    ["localhost", "https://localhost/admin"],
  ])("refuses a redirect to %s without fetching it", async (_label, location) => {
    const proxy = harness({ upstream: () => redirect(302, location) });
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/x" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("redirect was refused") });
    expect(proxy.upstreamCalls).toHaveLength(1);
  });

  test("gives up on a redirect loop after five hops", async () => {
    const proxy = harness({ upstream: (url) => redirect(302, url.pathname === "/a" ? "/b" : "/a") });
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/a" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("too many times") });
    // The first request plus five followed redirects.
    expect(proxy.upstreamCalls).toHaveLength(6);
  });

  test("turns a POST into a bodiless GET on a 303, as fetch would", async () => {
    const proxy = harness({
      upstream: (url) => (url.pathname === "/submit" ? redirect(303, "/result") : Response.json({})),
    });
    await proxy.send(proxyRequest({
      url: "https://substack.com/submit",
      init: { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    }));
    const followed = proxy.upstreamCalls[1]!;

    expect(followed.init.method).toBe("GET");
    expect(followed.init.body).toBeUndefined();
    expect(new Headers(followed.init.headers).get("content-type")).toBeNull();
  });

  test("keeps the method and body on a 307", async () => {
    const proxy = harness({
      upstream: (url) => (url.pathname === "/submit" ? redirect(307, "/v2/submit") : Response.json({})),
    });
    await proxy.send(proxyRequest({ url: "https://substack.com/submit", init: { method: "PUT", body: "{\"a\":1}" } }));

    expect(proxy.upstreamCalls[1]?.init.method).toBe("PUT");
    expect(proxy.upstreamCalls[1]?.init.body).toBe("{\"a\":1}");
  });

  test("hands the redirect back when the plugin asked for manual handling", async () => {
    const proxy = harness({ upstream: () => redirect(302, "https://evil.example/x") });
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/x", init: { redirect: "manual" } }));
    const envelope = await response.json() as { status: number; headers: Record<string, string> };

    expect(envelope.status).toBe(302);
    expect(envelope.headers.location).toBe("https://evil.example/x");
    expect(proxy.upstreamCalls).toHaveLength(1);
  });

  test("refuses any redirect when the plugin asked for redirect errors", async () => {
    const proxy = harness({ upstream: () => redirect(302, "https://substack.com/elsewhere") });
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/x", init: { redirect: "error" } }));

    expect(response.status).toBe(502);
    expect(proxy.upstreamCalls).toHaveLength(1);
  });
});

describe("proxy response size", () => {
  test("cuts off a body that grows past the limit and stops reading it", async () => {
    const { stream, state } = endlessBody(1024 * 1024);
    const proxy = harness({ upstream: () => new Response(stream, { status: 200 }) });
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/huge" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("larger than 5 MB") });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  test("refuses a declared Content-Length over the limit before reading", async () => {
    const { stream, state } = endlessBody(1024);
    const proxy = harness({
      upstream: () => new Response(stream, { status: 200, headers: { "content-length": String(6 * 1024 * 1024) } }),
    });
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/huge" }));

    expect(response.status).toBe(502);
    expect(state.cancelled).toBe(true);
    // Only what the stream buffers ahead of a reader, nothing read on purpose.
    expect(state.pulled).toBeLessThanOrEqual(1024);
  });

  test("passes a body just under the limit through intact", async () => {
    const body = "a".repeat(5 * 1024 * 1024);
    const proxy = harness({ upstream: () => new Response(body, { status: 200 }) });
    const response = await proxy.send(proxyRequest({ url: "https://substack.com/big" }));
    const envelope = await response.json() as { body: string };

    expect(response.status).toBe(200);
    expect(envelope.body.length).toBe(body.length);
  });

  test("decodes multi-byte text split across chunks", async () => {
    const bytes = new TextEncoder().encode("€uro");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1));
        controller.close();
      },
    });
    const proxy = harness({ upstream: () => new Response(stream) });
    const envelope = await (await proxy.send(proxyRequest({ url: "https://substack.com/x" }))).json() as { body: string };

    expect(envelope.body).toBe("€uro");
  });
});
