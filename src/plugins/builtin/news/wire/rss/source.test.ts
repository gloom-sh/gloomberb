import { describe, expect, mock, test } from "bun:test";
import { MemoryPluginPersistence as MemoryPersistence } from "../../../../../test-support/plugin-persistence";
import { createRssNewsCapability, RSS_FEED_CACHE_POLICY } from "./source";
import type { RssFeedConfig } from "./parser";

const FEED: RssFeedConfig = {
  id: "example-feed",
  url: "https://example.com/rss.xml",
  name: "Example",
  category: "general",
  authority: 80,
  enabled: true,
};

const RSS_FIXTURE = `<rss version="2.0"><channel><item>
  <title>Breaking: NVIDIA rallies on AI demand</title>
  <link>https://example.com/nvda</link>
  <pubDate>${new Date().toUTCString()}</pubDate>
  <description>NVIDIA shares moved higher.</description>
</item></channel></rss>`;

describe("createRssNewsCapability", () => {
  test("does not serve unclassified RSS stories as top news", async () => {
    const fetchText = mock(async () => ({
      ok: true,
      text: async () => RSS_FIXTURE,
    }));
    const source = createRssNewsCapability([FEED], { fetchText });

    expect(source.provider.supports?.({ feed: "top" })).toBe(false);
    expect(await source.provider.fetchNews({ feed: "top" })).toEqual([]);
    expect(fetchText).not.toHaveBeenCalled();
  });

  test("caches fetched feed items with feed authority scoring", async () => {
    const persistence = new MemoryPersistence();
    const fetchText = mock(async () => ({
      ok: true,
      text: async () => RSS_FIXTURE,
    }));
    const source = createRssNewsCapability([FEED], { persistence, fetchText });

    const items = await source.provider.fetchNews({ scope: "global" });

    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
    expect(items[0]!.importance).toBeGreaterThanOrEqual(FEED.authority);
    expect(items[0]!.isBreaking).toBe(true);
    expect(source.provider.getCachedNews?.({ scope: "global" })).toHaveLength(1);
  });

  test("uses fresh plugin cache without refetching", async () => {
    const persistence = new MemoryPersistence();
    const source = createRssNewsCapability([FEED], {
      persistence,
      fetchText: async () => {
        throw new Error("should not fetch");
      },
    });

    persistence.setResource("rss-feed", FEED.id, {
      items: [{
        id: "cached",
        title: "Cached headline",
        url: "https://example.com/cached",
        source: FEED.name,
        publishedAt: new Date().toISOString(),
        categories: ["general"],
        tickers: [],
        importance: 60,
        isBreaking: false,
      }],
    }, {
      sourceKey: FEED.url,
      cachePolicy: RSS_FEED_CACHE_POLICY,
    });

    const items = await source.provider.fetchNews({ scope: "global" });

    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Cached headline");
  });

  test("falls back to stale plugin cache when refresh fails", async () => {
    const persistence = new MemoryPersistence();
    const stalePolicy = { staleMs: -1, expireMs: 60_000 };
    persistence.setResource("rss-feed", FEED.id, {
      items: [{
        id: "stale",
        title: "Stale headline",
        url: "https://example.com/stale",
        source: FEED.name,
        publishedAt: new Date().toISOString(),
        categories: ["general"],
        tickers: [],
        importance: 50,
        isBreaking: false,
      }],
    }, {
      sourceKey: FEED.url,
      cachePolicy: stalePolicy,
    });

    const source = createRssNewsCapability([FEED], {
      persistence,
      fetchText: async () => {
        throw new Error("network down");
      },
    });

    const items = await source.provider.fetchNews({ scope: "global" });

    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Stale headline");
  });
});
