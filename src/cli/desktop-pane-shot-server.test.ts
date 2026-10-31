import { afterAll, expect, test } from "bun:test";
import { answerShotApiCall, serveShotPage, type DesktopPaneShotBridge } from "./desktop-pane-shot";
import {
  SHOT_API_PROXY_PREFIX,
  SHOT_API_SOCKET_PATH,
  SHOT_HTTP_BRIDGE_PATH,
  SHOT_MARKET_BRIDGE_PATH,
  shotRouteUrl,
} from "./desktop-pane-shot-routes";

// The page's Cloud API reads go over one socket (a page's fetches share six connections to its origin);
// each must reach the API as the proxy sends it, with the session the page never holds.
const asked: Array<{ method: string; path: string; cookie: string | null; origin: string | null }> = [];
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    asked.push({ method: request.method, path: `${url.pathname}${url.search}`, cookie: request.headers.get("cookie"), origin: request.headers.get("origin") });
    if (url.pathname === "/v1/market/gone") return new Response(null, { status: 204 });
    return Response.json({ status: "success", data: { symbol: url.searchParams.get("symbol"), name: "Société Générale" } }, { headers: { "x-served": "yes" } });
  },
});
afterAll(() => upstream.stop(true));
const apiProxy = { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, sessionToken: "secret" };

test("a read sent over the page's socket reaches the API with the session, and its answer comes back whole", async () => {
  const reply = JSON.parse(await answerShotApiCall(JSON.stringify({
    id: 7, path: "/market/history?symbol=GLE&exchange=EPA", headers: [["accept", "application/json"], ["cookie", "page=1"]],
  }), apiProxy));
  expect(reply).toMatchObject({ id: 7, status: 200 });
  expect(new Map(reply.headers).get("x-served")).toBe("yes");
  expect(JSON.parse(Buffer.from(reply.body, "base64").toString("utf8")).data).toEqual({ symbol: "GLE", name: "Société Générale" });
  const sent = asked.at(-1)!;
  expect(sent.path).toBe("/v1/market/history?symbol=GLE&exchange=EPA");
  // The session is Bun's, never the page's cookie.
  expect(sent.cookie).toContain("secret");
  expect(sent.cookie).not.toContain("page=1");
  expect(sent.origin).toBe(`http://127.0.0.1:${upstream.port}`);

  expect(JSON.parse(await answerShotApiCall(JSON.stringify({ id: 8, path: "/market/gone", headers: [] }), apiProxy)))
    .toMatchObject({ id: 8, status: 204, body: "" });
  // Only a path on the API: another host is refused, not fetched.
  const count = asked.length;
  for (const path of ["//evil.example/x", "https://evil.example/x", 3]) {
    expect(JSON.parse(await answerShotApiCall(JSON.stringify({ id: 9, path, headers: [] }), apiProxy))).toEqual({ id: 9, error: "Not an API path." });
  }
  // Reads the page has no use for, the account's among them, are refused before they reach the API.
  for (const path of ["/teams", "/account/mcp/keys", "/chat/channels", "/cloud/auth/browser-handoff", "/market/..%2fauth%2fsign-out"]) {
    expect(JSON.parse(await answerShotApiCall(JSON.stringify({ id: 10, path, headers: [] }), apiProxy))).toMatchObject({ id: 10, status: 403 });
  }
  expect(asked.length).toBe(count);
});

/** A socket to the shot server from `origin`: open, or null when the server refused it. */
function connect(url: URL, origin: string | null): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: origin ? { Origin: origin } : {} } as never);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => resolve(null), { once: true });
    socket.addEventListener("close", () => resolve(null), { once: true });
  });
}

function socketUrl(page: string): URL {
  const url = shotRouteUrl(SHOT_API_SOCKET_PATH, page);
  url.protocol = "ws:";
  return url;
}

// Any program on the machine and any website open in the user's browser can reach the local port; behind it are
// the capture's data, reads made with the user's session and fetches made from the user's machine.
test("every route answers only the capture's page: its secret folder, named as 127.0.0.1:<port>", async () => {
  const bridged: string[] = [];
  const bridge: DesktopPaneShotBridge = {
    async marketData(operation) {
      bridged.push(operation);
      return { quote: 1 };
    },
    async httpFetch(request) {
      bridged.push(request.url);
      return { status: 200, statusText: "OK", headers: {}, body: "fetched" };
    },
  };
  const server = serveShotPage(new Map([["cli-pane-shot-entry.js", "export {};"]]), "<html>capture</html>", apiProxy, bridge);
  try {
    const page = server.url;
    const { origin, host } = new URL(page);
    expect(page).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/$/);
    const json = { method: "POST", headers: { "content-type": "application/json" } };
    const routes: Array<{ route: string; init?: RequestInit; served: (response: Response) => Promise<void> }> = [
      { route: "/", served: async (response) => expect(await response.text()).toBe("<html>capture</html>") },
      { route: "/cli-pane-shot-entry.js", served: async (response) => expect(await response.text()).toBe("export {};") },
      { route: `${SHOT_API_PROXY_PREFIX}/market/quote?symbol=GLE`, served: async (response) => expect(response.headers.get("x-served")).toBe("yes") },
      {
        route: SHOT_MARKET_BRIDGE_PATH,
        init: { ...json, body: JSON.stringify({ operation: "getQuote", args: ["GLE"] }) },
        served: async (response) => expect(await response.json()).toEqual({ ok: true, data: { quote: 1 } }),
      },
      {
        route: SHOT_HTTP_BRIDGE_PATH,
        init: { ...json, body: JSON.stringify({ url: "https://api.example.com/x" }) },
        served: async (response) => expect(await response.json()).toMatchObject({ ok: true, data: { body: "fetched" } }),
      },
    ];
    const count = asked.length;
    for (const { route, init } of routes) {
      const inFolder = shotRouteUrl(route, page);
      const refusals: Array<[URL | string, Record<string, string>]> = [
        // Without the secret folder, or with another one.
        [new URL(`.${route}`, origin), {}],
        [shotRouteUrl(route, `${origin}/${"0".repeat(64)}/`), {}],
        [shotRouteUrl(route, `${origin}/${page.split("/")[3]!.slice(1)}/`), {}],
        // The right folder under another name: a website that rebound its own name to 127.0.0.1.
        [inFolder, { Host: `evil.example:${new URL(page).port}` }],
        [inFolder, { Host: `localhost:${new URL(page).port}` }],
        // The right folder asked from another site's page.
        [inFolder, { Origin: "https://evil.example" }],
      ];
      for (const [url, headers] of refusals) {
        const response = await fetch(url, { ...init, headers: { ...init?.headers as Record<string, string>, ...headers } });
        expect(response.status).toBe(403);
      }
    }
    expect(asked.length).toBe(count);
    expect(bridged).toEqual([]);

    for (const { route, init, served } of routes) {
      const response = await fetch(shotRouteUrl(route, page), { ...init, headers: { ...init?.headers as Record<string, string>, Host: host, Origin: origin } });
      expect(response.status).toBe(200);
      await served(response);
    }
    expect(bridged).toEqual(["getQuote", "https://api.example.com/x"]);

    // The socket: another site's page, a missing origin and a missing secret are refused before any read.
    for (const from of ["https://evil.example", `http://localhost:${new URL(page).port}`, null]) {
      expect(await connect(socketUrl(page), from)).toBeNull();
    }
    expect(await connect(socketUrl(`${origin}/${"0".repeat(64)}/`), origin)).toBeNull();
    expect(await connect(socketUrl(`${origin}/`), origin)).toBeNull();
    const socket = await connect(socketUrl(page), origin);
    expect(socket).not.toBeNull();
    const reply = new Promise<string>((resolve) => socket!.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));
    socket!.send(JSON.stringify({ id: 3, path: "/market/quote?symbol=GLE", headers: [] }));
    expect(JSON.parse(await reply)).toMatchObject({ id: 3, status: 200 });
    expect(asked.at(-1)!.cookie).toContain("secret");
    socket!.close();
  } finally {
    server.stop();
  }
});

test("the API proxy sends the reads panes make and refuses anything that acts on the account", async () => {
  const server = serveShotPage(new Map(), "<html></html>", apiProxy, null);
  try {
    const page = server.url;
    const send = (method: string, path: string, body?: unknown) => fetch(shotRouteUrl(`${SHOT_API_PROXY_PREFIX}${path}`, page), {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const count = asked.length;
    for (const [method, path] of [
      ["POST", "/auth/sign-out"],
      ["POST", "/stripe/subscription/cancel"],
      ["POST", "/account/mcp/keys"],
      ["POST", "/chat/direct"],
      ["POST", "/teams"],
      ["PUT", "/sync/snapshot"],
      ["DELETE", "/cloud/search/saved/1"],
      ["PATCH", "/market/quote"],
      ["POST", "/cloud/search/saved"],
      ["GET", "/account/calendar-feed"],
    ] as const) {
      expect((await send(method, path, method === "GET" ? undefined : {})).status).toBe(403);
    }
    expect(asked.length).toBe(count);

    // A batch read sent as POST still reaches the API, with the user's session.
    const batch = await send("POST", "/market/quotes/batch", { targets: [{ symbol: "GLE", exchange: "EPA" }], mode: "cache-first" });
    expect(batch.status).toBe(200);
    expect(asked.at(-1)).toMatchObject({ method: "POST", path: "/v1/market/quotes/batch" });
    expect(asked.at(-1)!.cookie).toContain("secret");
    expect((await send("GET", "/auth/get-session")).status).toBe(200);
  } finally {
    server.stop();
  }
});
