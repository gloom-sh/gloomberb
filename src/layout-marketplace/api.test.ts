import { describe, expect, test } from "bun:test";
import {
  getPublicMarketplaceLayout,
  marketplaceLayoutIdFromSearch,
  parseMarketplaceLayoutId,
} from "./api";

const id = "0123456789abcdef0123456789abcdef";
const entry = {
  id,
  name: "Social Desk",
  schemaVersion: 2,
  sourceConfigVersion: 21,
  layout: {
    dockRoot: { kind: "pane", instanceId: "p1" },
    instances: [{
      instanceId: "p1",
      paneId: "twitter-feed",
      params: { query: "$NVDA" },
    }],
    floating: [],
    detached: [],
  },
  paneState: {},
  author: { username: "analyst", displayName: "Analyst" },
  publishedAt: "2026-08-27T00:00:00.000Z",
};

describe("public marketplace layout links", () => {
  test("loads and validates an anonymous layout item", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const loaded = await getPublicMarketplaceLayout(id, async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(entry), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    expect(loaded).toEqual(entry);
    expect(new URL(calls[0]![0]).pathname).toBe(`/layouts/${id}`);
    expect(calls[0]![1]?.credentials).toBe("include");
  });

  test("reads layout ids from links and rejects malformed ones", () => {
    expect(marketplaceLayoutIdFromSearch(`?layout=${id}`)).toBe(id);
    expect(parseMarketplaceLayoutId(`/l/${id}`)).toBe(id);
    expect(parseMarketplaceLayoutId("/l/not-an-id")).toBeNull();
  });
});
