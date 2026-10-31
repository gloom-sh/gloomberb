import { afterAll, expect, test } from "bun:test";
import { answerShotApiCall, serveShotPage } from "./desktop-pane-shot";
import { SHOT_API_SOCKET_PATH } from "./desktop-pane-shot-routes";

// The page's Cloud API reads go over one socket (a page's fetches share six connections to its origin);
// each must reach the API as the proxy sends it, with the session the page never holds.
const asked: Array<{ path: string; cookie: string | null; origin: string | null }> = [];
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    asked.push({ path: `${url.pathname}${url.search}`, cookie: request.headers.get("cookie"), origin: request.headers.get("origin") });
    if (url.pathname === "/v1/gone") return new Response(null, { status: 204 });
    return Response.json({ status: "success", data: { symbol: url.searchParams.get("symbol"), name: "Société Générale" } }, { headers: { "x-served": "yes" } });
  },
});
afterAll(() => upstream.stop(true));

test("a read sent over the page's socket reaches the API with the session, and its answer comes back whole", async () => {
  const apiProxy = { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, sessionToken: "secret" };
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

  expect(JSON.parse(await answerShotApiCall(JSON.stringify({ id: 8, path: "/gone", headers: [] }), apiProxy)))
    .toMatchObject({ id: 8, status: 204, body: "" });
  // Only a path on the API: another host is refused, not fetched.
  const count = asked.length;
  for (const path of ["//evil.example/x", "https://evil.example/x", 3]) {
    expect(JSON.parse(await answerShotApiCall(JSON.stringify({ id: 9, path, headers: [] }), apiProxy))).toEqual({ id: 9, error: "Not an API path." });
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

// Any website open in the user's browser can reach the local port, and a socket's replies are reads made with the user's session.
test("the API socket opens only for the capture's page: its own origin, holding its token", async () => {
  const token = "a".repeat(64);
  const server = serveShotPage(new Map(), "<html></html>", { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, sessionToken: "secret" }, null, token);
  try {
    const page = `http://127.0.0.1:${server.port}`;
    const socketUrl = (given: string | null) => {
      const url = new URL(SHOT_API_SOCKET_PATH, page.replace(/^http/, "ws"));
      if (given !== null) url.searchParams.set("token", given);
      return url;
    };
    const count = asked.length;
    // Another site's page holding the token, and the page's own origin without it, are refused before any read.
    for (const origin of ["https://evil.example", `http://localhost:${server.port}`, null]) {
      expect(await connect(socketUrl(token), origin)).toBeNull();
    }
    for (const given of [null, "", "b".repeat(64), token.slice(1)]) {
      expect(await connect(socketUrl(given), page)).toBeNull();
    }
    expect(asked.length).toBe(count);

    const socket = await connect(socketUrl(token), page);
    expect(socket).not.toBeNull();
    const reply = new Promise<string>((resolve) => socket!.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));
    socket!.send(JSON.stringify({ id: 3, path: "/market/quote?symbol=GLE", headers: [] }));
    expect(JSON.parse(await reply)).toMatchObject({ id: 3, status: 200 });
    expect(asked.at(-1)!.cookie).toContain("secret");
    socket!.close();
  } finally {
    server.stop(true);
  }
});
