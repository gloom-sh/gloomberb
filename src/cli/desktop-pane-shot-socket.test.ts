import { afterAll, expect, test } from "bun:test";
import { answerShotApiCall } from "./desktop-pane-shot";

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
