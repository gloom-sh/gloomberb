import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBrowserHttpProxyTransport } from "./http-proxy-transport";

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
    }) as unknown as typeof fetch);

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
    })) as unknown as typeof fetch);

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
    }) as unknown as typeof fetch);

    await transport("/api/portfolio");
    await transport("https://plugins.gloom.sh/registry.json");
    await transport("https://api.fiscaldata.treasury.gov/services/api/v1/auctions");

    expect(calls).toEqual([
      "/api/portfolio",
      "https://plugins.gloom.sh/registry.json",
      "https://api.fiscaldata.treasury.gov/services/api/v1/auctions",
    ]);
  });

  test("surfaces a refusal from the proxy instead of returning it as a response", async () => {
    const transport = createBrowserHttpProxyTransport((async () => Response.json(
      { error: "Sign in to use plugin requests." },
      { status: 401 },
    )) as unknown as typeof fetch);

    await expect(transport("https://substack.com/api/v1/reader/feed")).rejects.toThrow("refused (401)");
  });
});
