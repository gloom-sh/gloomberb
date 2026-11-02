import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBrowserHttpProxyTransport } from "./http-proxy-transport";

// The real allowlist is generated from what bundled plugins declare. These
// tests are about routing, so they pin one example host.
const HOSTS = ["substack.com"];

const originalLocation = Reflect.get(globalThis, "location");

beforeAll(() => {
  Object.defineProperty(globalThis, "location", {
    value: { href: "https://term.gloom.sh/", origin: "https://term.gloom.sh", protocol: "https:" },
    configurable: true,
  });
});

afterAll(() => {
  if (originalLocation === undefined) {
    Reflect.deleteProperty(globalThis, "location");
    return;
  }
  Object.defineProperty(globalThis, "location", { value: originalLocation, configurable: true });
});

describe("browser plugin transport", () => {
  test("sends a cross-origin request to the proxy as an envelope", async () => {
    // `Cookie` cannot be set on a browser fetch, so it has to travel in the
    // body rather than as a header on the request to the worker.
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = createBrowserHttpProxyTransport((async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        setCookie: ["substack.sid=granted; Path=/"],
        body: "{\"ok\":true}",
      });
    }) as unknown as typeof fetch, HOSTS);

    const response = await transport("https://substack.com/api/v1/reader/feed", {
      headers: { cookie: "substack.sid=stored" },
    });

    expect(calls[0]?.url).toBe("/http-proxy");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      url: "https://substack.com/api/v1/reader/feed",
      init: { headers: { cookie: "substack.sid=stored" } },
    });
    expect(await response.json()).toEqual({ ok: true });
  });

  test("restores set-cookie so a plugin can complete a login", async () => {
    const transport = createBrowserHttpProxyTransport((async () => Response.json({
      status: 200,
      statusText: "OK",
      headers: {},
      setCookie: ["substack.sid=granted; Path=/", "other=1"],
      body: "{}",
    })) as unknown as typeof fetch, HOSTS);

    const response = await transport("https://substack.com/api/v1/login");

    expect(response.headers.get("set-cookie")).toContain("substack.sid=granted");
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  test("leaves same-origin and CORS-friendly hosts on the direct path", async () => {
    // The marketplace feed and the public data sources already work from a
    // browser. Routing them through the proxy would cost a round trip and the
    // worker would refuse them, since they are not on the allowlist.
    const calls: string[] = [];
    const transport = createBrowserHttpProxyTransport((async (url: string) => {
      calls.push(String(url));
      return new Response("ok");
    }) as unknown as typeof fetch, HOSTS);

    await transport("/api/portfolio");
    await transport("https://plugins.gloom.sh/registry.json");
    await transport("https://api.fiscaldata.treasury.gov/services/api/v1/auctions");

    expect(calls).toEqual([
      "/api/portfolio",
      "https://plugins.gloom.sh/registry.json",
      "https://api.fiscaldata.treasury.gov/services/api/v1/auctions",
    ]);
  });

  // Panes print the error message as is, so a refusal has to arrive as a
  // sentence: never the worker's JSON, an edge HTML page or a status code.
  test.each([
    ["the worker's error", () => Response.json({ error: "The data source timed out. Try again shortly." }, { status: 504 }), "The data source timed out. Try again shortly."],
    ["an edge HTML page", () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }), "The data source could not be reached. Try again shortly."],
    ["an error that is itself JSON", () => Response.json({ error: "{\"code\":1}" }, { status: 429 }), "Too many requests right now. Try again in a minute."],
    ["an empty body", () => new Response(null, { status: 403 }), "This request could not be completed."],
  ])("turns a refusal with %s into a plain sentence", async (_label, refusal, message) => {
    const transport = createBrowserHttpProxyTransport((async () => refusal()) as unknown as typeof fetch, HOSTS);
    const error = await transport("https://substack.com/api/v1/reader/feed").then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
  });
});
