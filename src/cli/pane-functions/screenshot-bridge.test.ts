import { expect, test } from "bun:test";
import { createDesktopShotBridge } from "./screenshot-bridge";

/** A bridge whose host names resolve from `dns` and whose fetches are recorded and answered by `answer`. */
function bridgeWith(dns: Record<string, string[]>, answer: (url: string, init: RequestInit) => Response) {
  const fetched: Array<{ url: string; method: string; cookie: string | null }> = [];
  const fakeFetch = (async (input: URL | string, init: RequestInit = {}) => {
    const url = String(input);
    fetched.push({ url, method: init.method ?? "GET", cookie: new Headers(init.headers).get("cookie") });
    return answer(url, init);
  }) as typeof fetch;
  const bridge = createDesktopShotBridge({ dataProvider: {} as never }, undefined, {
    fetch: fakeFetch,
    resolveHost: async (host) => {
      const addresses = dns[host];
      if (!addresses) throw new Error(`ENOTFOUND ${host}`);
      return addresses;
    },
  });
  return { bridge, fetched };
}

// The bridge fetches from the user's machine for panes that read third-party APIs and feeds.
test("the HTTP bridge reaches public hosts only, and checks every redirect like the first URL", async () => {
  const { bridge, fetched } = bridgeWith({
    "feeds.example.com": ["93.184.215.14"],
    "moved.example.com": ["2606:4700::6810:84e5"],
    "intranet.example.com": ["10.0.0.5"],
    "rebound.example.com": ["93.184.215.14", "127.0.0.1"],
  }, (url) => {
    if (url === "https://feeds.example.com/moved") return new Response(null, { status: 301, headers: { location: "https://moved.example.com/feed" } });
    if (url === "https://feeds.example.com/inside") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    if (url === "https://feeds.example.com/named") return new Response(null, { status: 307, headers: { location: "https://intranet.example.com/admin" } });
    return new Response(`body of ${url}`);
  });

  for (const url of [
    "http://127.0.0.1:8080/", "http://2130706433/", "http://0x7f.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://localhost:3000/", "http://app.localhost/",
    "https://intranet.example.com/", "https://rebound.example.com/", "https://unknown.example.com/",
    "file:///etc/passwd", "ftp://feeds.example.com/", "https://user:pass@feeds.example.com/", "not a url",
  ]) {
    await expect(bridge.httpFetch({ url })).rejects.toThrow();
  }
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    await expect(bridge.httpFetch({ url: "https://feeds.example.com/x", init: { method } })).rejects.toThrow(`refuses ${method}`);
  }
  expect(fetched).toEqual([]);

  // A public host is fetched, a GET and the POST some APIs take a query as.
  expect((await bridge.httpFetch({ url: "https://feeds.example.com/rss" })).body).toBe("body of https://feeds.example.com/rss");
  expect((await bridge.httpFetch({ url: "https://feeds.example.com/query", init: { method: "POST", body: "{}" } })).status).toBe(200);
  // A redirect to another public host is followed, without the cookie set for the first.
  const moved = await bridge.httpFetch({ url: "https://feeds.example.com/moved", init: { headers: { cookie: "session=1" } } });
  expect(moved.body).toBe("body of https://moved.example.com/feed");
  expect(fetched.at(-1)).toEqual({ url: "https://moved.example.com/feed", method: "GET", cookie: null });
  // A redirect into the machine or its network is refused before it is fetched.
  const count = fetched.length;
  await expect(bridge.httpFetch({ url: "https://feeds.example.com/inside" })).rejects.toThrow("redirect was refused");
  await expect(bridge.httpFetch({ url: "https://feeds.example.com/named" })).rejects.toThrow("redirect was refused");
  expect(fetched.slice(count).map((entry) => entry.url)).toEqual(["https://feeds.example.com/inside", "https://feeds.example.com/named"]);
});
