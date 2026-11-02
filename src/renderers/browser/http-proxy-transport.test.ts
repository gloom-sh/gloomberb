import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isNetworkFailure } from "../../utils/network-failure";
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

  test("leaves User-Agent off a direct request, as every browser would", async () => {
    // Chrome drops it on its own; Firefox sends it, and the preflight that
    // costs is refused by some of the hosts the browser calls directly.
    const sent: Headers[] = [];
    const transport = createBrowserHttpProxyTransport((async (_url: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return new Response("[]");
    }) as unknown as typeof fetch, HOSTS);

    await transport("https://gamma-api.polymarket.com/events", { headers: { Accept: "application/json", "User-Agent": "gloomberb-prediction-markets" } });

    expect(sent[0]?.get("user-agent")).toBeNull();
    expect(sent[0]?.get("accept")).toBe("application/json");
  });

  // Panes print the error message as is, so a refusal has to arrive as a
  // sentence: never the worker's JSON, an HTML page, the browser's own words
  // or a status code.
  test.each([
    ["the worker's error", () => Response.json({ error: "The data source timed out. Try again shortly." }, { status: 504 }), "The data source timed out. Try again shortly."],
    ["an edge HTML page", () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }), "The data source could not be reached. Try again shortly."],
    ["an error that is itself JSON", () => Response.json({ error: "{\"code\":1}" }, { status: 429 }), "Too many requests right now. Try again in a minute."],
    ["an error too long to be the worker's", () => Response.json({ error: "word ".repeat(60) }, { status: 400 }), "This request could not be completed."],
    ["an empty body", () => new Response(null, { status: 403 }), "This request could not be completed."],
    ["a 200 HTML page instead of an envelope", () => new Response("<!doctype html><html><title>Gloom</title></html>", { status: 200 }), "The data source's answer could not be read. Try again shortly."],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch")), "The data source could not be reached. Check your connection and try again."],
  ])("turns %s into a plain sentence", async (_label, refusal, message) => {
    const transport = createBrowserHttpProxyTransport((async () => refusal()) as unknown as typeof fetch, HOSTS);
    const error = await transport("https://substack.com/api/v1/reader/feed").then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
  });

  test("keeps a network failure recognizable and a caller's abort as it was", async () => {
    const failing = createBrowserHttpProxyTransport((async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof fetch, HOSTS);
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    const aborting = createBrowserHttpProxyTransport((async () => {
      throw aborted;
    }) as unknown as typeof fetch, HOSTS);

    const direct = await failing("https://api.thebuildout.ai/lists").then(() => null, (thrown: unknown) => thrown);
    const proxied = await failing("https://substack.com/x").then(() => null, (thrown: unknown) => thrown);

    expect(isNetworkFailure(direct)).toBe(true);
    expect(isNetworkFailure(proxied)).toBe(true);
    expect(await aborting("https://substack.com/x").then(() => null, (thrown: unknown) => thrown)).toBe(aborted);
  });
});
