import { describe, expect, mock, test } from "bun:test";
import { MemoryPluginPersistence as MemoryPersistence } from "../../../../../test-support/plugin-persistence";
import { createRssNewsCapability, RSS_FEED_CACHE_POLICY, RSS_FEED_CACHE_VERSION } from "./source";
import type { RssFeedConfig } from "./parser";
import { MANAGED_NEWS_FEED } from "./managed-feed";

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
      schemaVersion: RSS_FEED_CACHE_VERSION,
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
      schemaVersion: RSS_FEED_CACHE_VERSION,
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

test("partial feed failure preserves successful and stale articles, reports the gap, and recovers", async () => {
  const persistence = new MemoryPersistence();
  const other = { ...FEED, id: "other", url: "https://other.example.com/rss" };
  let broken = false;
  const source = createRssNewsCapability([FEED, other], { persistence, fetchText: async (url) => ({
    ok: true,
    text: async () => broken && url === FEED.url ? "<html><body>Proxy error</body></html>" : RSS_FIXTURE.replace("nvda</link>", `${url === FEED.url ? "nvda" : "other"}</link>`),
  }) });
  await source.provider.fetchNewsPage!({ feed: "latest" });
  const cached = persistence.getResource<{ items: unknown[] }>("rss-feed", FEED.id, { sourceKey: FEED.url })!;
  persistence.seedResource("rss-feed", FEED.id, cached.value, { sourceKey: FEED.url, schemaVersion: RSS_FEED_CACHE_VERSION, stale: true });
  broken = true;
  const failed = await source.provider.fetchNewsPage!({ feed: "latest" });
  expect(failed.articles).toHaveLength(2);
  expect(failed.error).toBe("1 of 2 RSS feeds unavailable.");
  expect(persistence.getResource("rss-feed", FEED.id, { sourceKey: FEED.url })!.stale).toBe(true);
  broken = false;
  expect((await source.provider.fetchNewsPage!({ feed: "latest" })).error).toBeNull();
  expect(persistence.getResource("rss-feed", FEED.id, { sourceKey: FEED.url })!.stale).toBe(false);
});

test("legacy parser cache is refetched and valid empty feeds are cached without claiming pagination", async () => {
  const persistence = new MemoryPersistence();
  persistence.setResource("rss-feed", FEED.id, { items: [{ id: "old", title: "Old self link", url: "https://example.com/api", source: FEED.name, publishedAt: new Date().toISOString() }] }, { sourceKey: FEED.url, cachePolicy: RSS_FEED_CACHE_POLICY });
  const fetchText = mock(async () => ({ ok: true, text: async () => '<feed xmlns="http://www.w3.org/2005/Atom"/>' }));
  const source = createRssNewsCapability([FEED], { persistence, fetchText });
  expect(source.provider.getCachedNews!({ feed: "latest" })).toEqual([]);
  expect((await source.provider.fetchNewsPage!({ feed: "latest" })).articles).toEqual([]);
  expect((await source.provider.fetchNewsPage!({ feed: "latest" })).error).toBeNull();
  expect(fetchText).toHaveBeenCalledTimes(1);
  expect(source.provider.supports!({ feed: "latest", cursor: "next" })).toBe(false);
  expect((await source.provider.fetchNewsPage!({ feed: "latest", cursor: "next" })).articles).toEqual([]);
  expect(fetchText).toHaveBeenCalledTimes(1);
});

test("an old feed-label cache cannot return as fresh data or an outage fallback", async () => {
  const persistence = new MemoryPersistence();
  persistence.seedResource("rss-feed", MANAGED_NEWS_FEED.id, { items: [{
    id: "old", title: "Old syndicated story", url: "https://delivery.example/item", source: "Old delivery service", publishedAt: new Date().toISOString(),
  }] }, { sourceKey: MANAGED_NEWS_FEED.url, schemaVersion: 2 });
  let available = false;
  const source = createRssNewsCapability([MANAGED_NEWS_FEED], { persistence, fetchText: async () => ({
    ok: available,
    text: async () => RSS_FIXTURE.replace("</item>", '<source url="https://publisher.example/rss">Actual Publisher</source></item>'),
  }) });
  expect(source.provider.getCachedNews!({ feed: "latest" })).toEqual([]);
  expect((await source.provider.fetchNewsPage!({ feed: "latest" })).articles).toEqual([]);
  available = true;
  expect((await source.provider.fetchNewsPage!({ feed: "latest" })).articles[0]?.source).toBe("Actual Publisher");
  expect(source.provider.getCachedNews!({ feed: "latest" })[0]?.source).toBe("Actual Publisher");
});
