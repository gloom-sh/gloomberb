import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { NewsService } from "./aggregator";
import { newsProvider, type NewsCapability } from "../capabilities";
import type { MarketNewsItem } from "../types/news-source";

function makeItem(overrides: Partial<MarketNewsItem> & { url: string }): MarketNewsItem {
  return {
    ...overrides,
    id: overrides.id ?? overrides.url,
    title: "Test headline",
    url: overrides.url,
    source: "Test",
    publishedAt: overrides.publishedAt ?? new Date(),
    topic: overrides.topic ?? "general",
    topics: overrides.topics ?? [overrides.topic ?? "general"],
    sectors: overrides.sectors ?? [],
    categories: overrides.categories ?? [],
    tickers: [],
    scores: overrides.scores ?? {
      importance: overrides.importance ?? 50,
      urgency: overrides.isBreaking ? 80 : 0,
      marketImpact: overrides.importance ?? 50,
      novelty: 0,
      confidence: 0,
    },
    importance: overrides.importance ?? 50,
    isBreaking: overrides.isBreaking ?? false,
    isDeveloping: overrides.isDeveloping ?? false,
    summary: undefined,
  };
}

function makeSource(id: string, items: MarketNewsItem[]): NewsCapability {
  return newsProvider({
    id,
    name: id,
    provider: {
      fetchNews: mock(async () => items),
    },
  });
}

function makeCachedSource(id: string, cachedItems: MarketNewsItem[], fetchItems: MarketNewsItem[] = []): NewsCapability {
  return newsProvider({
    id,
    name: id,
    provider: {
      getCachedNews: () => cachedItems,
      fetchNews: mock(async () => fetchItems),
    },
  });
}

function makeFailingSource(id: string): NewsCapability {
  return newsProvider({
    id,
    name: id,
    provider: {
      fetchNews: mock(async () => {
        throw new Error("boom");
      }),
    },
  });
}

function makeStorySource(id: string, items: MarketNewsItem[], story: MarketNewsItem): NewsCapability {
  return newsProvider({
    id,
    name: id,
    provider: {
      fetchNews: mock(async () => items),
      fetchNewsStory: mock(async (storyId: string) => storyId === story.id ? story : null),
    },
  });
}

describe("NewsService", () => {
  let agg: NewsService;

  beforeEach(() => {
    agg = new NewsService();
  });

  afterEach(() => {
    agg.stop();
  });

  it("reports an error instead of an empty feed when every source fails", async () => {
    agg.register(makeFailingSource("broken"));
    const state = await agg.load({ feed: "latest" });

    expect(state.phase).toBe("error");
    expect(state.articles).toHaveLength(0);
  });

  it("stays ready but reports the gap when only some sources fail", async () => {
    agg.register(makeSource("ok", [makeItem({ url: "https://partial.example.com/1" })]));
    agg.register(makeFailingSource("broken"));
    const state = await agg.load({ feed: "latest" });

    expect(state.phase).toBe("ready");
    expect(state.articles).toHaveLength(1);
    expect(state.error).toContain("unavailable");
  });

  it("watchQuery shows loading while the initial fetch is in flight", () => {
    agg.register(makeSource("watch-loading", [makeItem({ url: "https://loading.example.com/1" })]));
    const phases: string[] = [];
    const dispose = agg.watchQuery({ feed: "latest" }, (state) => phases.push(state.phase));

    expect(phases[0]).toBe("loading");
    dispose();
  });

  it("deduplicates by URL, keeping higher importance", async () => {
    const low = makeItem({ url: "https://example.com/1", importance: 40 });
    const high = makeItem({ url: "https://example.com/1", importance: 80 });

    agg.register(makeSource("a", [low]));
    agg.register(makeSource("b", [high]));
    await agg.poll();

    const stories = agg.getTopStories(10);
    expect(stories).toHaveLength(1);
    expect(stories[0]!.importance).toBe(80);
  });

  it("getTopStories returns items sorted by importance descending", async () => {
    const items = [
      makeItem({ url: "https://a.com/1", importance: 30 }),
      makeItem({ url: "https://a.com/2", importance: 90 }),
      makeItem({ url: "https://a.com/3", importance: 60 }),
    ];
    agg.register(makeSource("a", items));
    await agg.poll();

    const stories = agg.getTopStories(10);
    expect(stories[0]!.importance).toBe(90);
    expect(stories[1]!.importance).toBe(60);
    expect(stories[2]!.importance).toBe(30);
  });

  it("getFirehose returns items sorted by publishedAt descending", async () => {
    const now = Date.now();
    const items = [
      makeItem({ url: "https://b.com/1", publishedAt: new Date(now - 3000) }),
      makeItem({ url: "https://b.com/2", publishedAt: new Date(now - 1000) }),
      makeItem({ url: "https://b.com/3", publishedAt: new Date(now - 2000) }),
    ];
    agg.register(makeSource("b", items));
    await agg.poll();

    const firehose = agg.getFirehose(undefined, 10);
    expect(firehose[0]!.url).toBe("https://b.com/2");
    expect(firehose[1]!.url).toBe("https://b.com/3");
    expect(firehose[2]!.url).toBe("https://b.com/1");
  });

  it("getFirehose filters to items after `since`", async () => {
    const now = Date.now();
    const cutoff = new Date(now - 2000);
    const items = [
      makeItem({ url: "https://c.com/old", publishedAt: new Date(now - 5000) }),
      makeItem({ url: "https://c.com/new", publishedAt: new Date(now - 1000) }),
    ];
    agg.register(makeSource("c", items));
    await agg.poll();

    const firehose = agg.getFirehose(cutoff, 10);
    expect(firehose).toHaveLength(1);
    expect(firehose[0]!.url).toBe("https://c.com/new");
  });

  it("getBySector filters to items containing the sector in categories", async () => {
    const items = [
      makeItem({ url: "https://d.com/1", categories: ["tech", "earnings"] }),
      makeItem({ url: "https://d.com/2", categories: ["energy"] }),
      makeItem({ url: "https://d.com/3", categories: ["tech"] }),
    ];
    agg.register(makeSource("d", items));
    await agg.poll();

    const tech = agg.getBySector("tech", 10);
    expect(tech).toHaveLength(2);
    expect(tech.every((i) => i.categories.includes("tech"))).toBe(true);
  });

  it("getBreaking returns items that are isBreaking=true", async () => {
    const items = [
      makeItem({ url: "https://e.com/1", isBreaking: true }),
      makeItem({ url: "https://e.com/2", isBreaking: false }),
    ];
    agg.register(makeSource("e", items));
    await agg.poll();

    const breaking = agg.getBreaking(10);
    expect(breaking.some((i) => i.url === "https://e.com/1")).toBe(true);
    expect(breaking.every((i) => i.url !== "https://e.com/2")).toBe(true);
  });

  it("getBreaking returns recent items with importance >= 70", async () => {
    const now = Date.now();
    const items = [
      makeItem({ url: "https://f.com/recent-high", publishedAt: new Date(now - 30 * 60 * 1000), importance: 75, isBreaking: false }),
      makeItem({ url: "https://f.com/recent-low", publishedAt: new Date(now - 30 * 60 * 1000), importance: 50, isBreaking: false }),
      makeItem({ url: "https://f.com/old-high", publishedAt: new Date(now - 2 * 60 * 60 * 1000), importance: 90, isBreaking: false }),
    ];
    agg.register(makeSource("f", items));
    await agg.poll();

    const breaking = agg.getBreaking(10);
    expect(breaking.some((i) => i.url === "https://f.com/recent-high")).toBe(true);
    expect(breaking.every((i) => i.url !== "https://f.com/recent-low")).toBe(true);
    expect(breaking.every((i) => i.url !== "https://f.com/old-high")).toBe(true);
  });

  it("retains at most 500 articles", async () => {
    const items = Array.from({ length: 600 }, (_, i) =>
      makeItem({
        url: `https://g.com/${i}`,
        publishedAt: new Date(Date.now() - i * 1000),
      }),
    );
    agg.register(makeSource("g", items));
    await agg.poll();

    expect(agg.getFirehose(undefined, 1000)).toHaveLength(500);
  });

  it("subscribe callback fires on poll and getVersion increments", async () => {
    let callCount = 0;
    const unsub = agg.subscribe(() => { callCount++; });

    const initialVersion = agg.getVersion();
    agg.register(makeSource("h", []));
    await agg.poll();

    expect(callCount).toBe(1);
    expect(agg.getVersion()).toBe(initialVersion + 1);

    await agg.poll();
    expect(callCount).toBe(2);
    expect(agg.getVersion()).toBe(initialVersion + 2);

    unsub();
    await agg.poll();
    expect(callCount).toBe(2); // unsubscribed, no more calls
  });

  it("watchQuery refreshes a query without a mounted pane", async () => {
    const item = makeItem({ url: "https://watch.example.com/1", isBreaking: true });
    const states: string[][] = [];

    agg.register(makeSource("watch", [item]));
    const dispose = agg.watchQuery(
      { feed: "breaking", breaking: true, limit: 20 },
      (state) => states.push(state.articles.map((article) => article.url)),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(states).toContainEqual([item.url]);

    const callCount = states.length;
    dispose();
    await agg.poll({ feed: "breaking", breaking: true, limit: 20 });
    expect(states).toHaveLength(callCount);
  });

  it("polls referenced queries only and stops after the last watcher leaves", async () => {
    const query = { feed: "latest" as const, limit: 20 };
    let fetchCount = 0;
    const source = newsProvider({
      id: "poll-lifecycle",
      name: "poll-lifecycle",
      provider: {
        fetchNews: async () => {
          fetchCount++;
          return [];
        },
      },
    });
    agg.register(source);
    await agg.load(query);
    expect(fetchCount).toBe(1);

    agg.start();
    agg.register(makeSource("inactive-trigger", []));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCount).toBe(1);

    const dispose = agg.watchQuery(query, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCount).toBe(2);

    const disposeSecond = agg.watchQuery(query, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCount).toBe(3);

    agg.register(makeSource("active-trigger", []));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCount).toBe(4);

    dispose();
    agg.register(makeSource("single-watcher-trigger", []));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCount).toBe(5);

    disposeSecond();
    agg.register(makeSource("disposed-trigger", []));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCount).toBe(5);
  });

  it("retains inactive query state for remounts", async () => {
    const item = makeItem({ url: "https://remount.example.com/1" });
    const query = { feed: "latest" as const, limit: 20 };
    agg.register(makeSource("remount", [item]));
    await agg.load(query);

    const firstStates: string[][] = [];
    const dispose = agg.watchQuery(query, (state) => {
      firstStates.push(state.articles.map((article) => article.url));
    });
    dispose();

    const remountedStates: string[][] = [];
    const disposeRemount = agg.watchQuery(query, (state) => {
      remountedStates.push(state.articles.map((article) => article.url));
    });

    expect(firstStates[0]).toEqual([item.url]);
    expect(remountedStates[0]).toEqual([item.url]);
    disposeRemount();
  });

  it("bounds inactive query state by LRU and TTL", async () => {
    let now = 0;
    agg = new NewsService({
      inactiveQueryTtlMs: 10,
      maxInactiveQueries: 2,
      now: () => now,
    });
    agg.register(makeSource("bounded", [makeItem({ url: "https://bounded.example.com/1" })]));
    const first = { feed: "latest" as const, topics: ["first"], limit: 20 };
    const second = { feed: "latest" as const, topics: ["second"], limit: 20 };
    const third = { feed: "latest" as const, topics: ["third"], limit: 20 };

    await agg.load(first);
    now = 1;
    await agg.load(second);
    now = 2;
    await agg.load(third);

    expect(agg.getQueryState(first).phase).toBe("idle");
    expect(agg.getQueryState(third).phase).toBe("ready");

    now = 20;
    expect(agg.getQueryState(third).phase).toBe("idle");
  });

  it("seeds cached source items immediately on register", () => {
    const cached = makeItem({ url: "https://cached.example.com/1", importance: 70 });
    let callCount = 0;
    agg.subscribe(() => { callCount++; });

    const dispose = agg.register(makeCachedSource("cached", [cached]));

    expect(agg.getFirehose(undefined, 10)).toHaveLength(1);
    expect(agg.getFirehose(undefined, 10)[0]!.url).toBe(cached.url);
    expect(callCount).toBe(1);

    dispose();
  });

  it("register disposer removes the source", async () => {
    const item = makeItem({ url: "https://dispose.example.com/1" });
    const dispose = agg.register(makeSource("disposable", [item]));
    dispose();

    await agg.poll();

    expect(agg.getFirehose(undefined, 10)).toHaveLength(0);
  });

  it("ticker queries continue past empty high-priority sources", async () => {
    const empty = makeSource("empty", []);
    const fallbackItem = makeItem({ url: "https://fallback.example.com/1", tickers: ["AAPL"] });
    const fallback = makeSource("fallback", [fallbackItem]);
    agg.register({
      ...empty,
      priority: 10,
      provider: {
        ...empty.provider,
        supports: (query) => query.feed === "ticker" || query.scope === "ticker",
      },
    });
    agg.register({
      ...fallback,
      priority: 100,
      provider: {
        ...fallback.provider,
        supports: (query) => query.feed === "ticker" || query.scope === "ticker",
      },
    });

    const state = await agg.load({ feed: "ticker", ticker: "AAPL", limit: 10 });

    expect(state.articles).toHaveLength(1);
    expect(state.articles[0]!.url).toBe(fallbackItem.url);
    expect(state.sourceIds).toEqual(["fallback"]);
  });

  it("loads story detail and merges source items into existing query state", async () => {
    const listArticle = makeItem({
      id: "story-1",
      url: "https://detail.example.com/story",
      items: [],
    });
    const detailArticle = makeItem({
      ...listArticle,
      items: [{
        id: "item-2",
        sourceKey: "wire-b",
        sourceName: "Wire B",
        title: "Follow-up",
        url: "https://detail.example.com/follow-up",
        publishedAt: new Date("2026-04-01T10:05:00.000Z"),
      }, {
        id: "item-1",
        sourceKey: "wire-a",
        sourceName: "Wire A",
        title: "Original",
        url: "https://detail.example.com/original",
        publishedAt: new Date("2026-04-01T10:00:00.000Z"),
      }],
    });

    agg.register(makeStorySource("cloud", [listArticle], detailArticle));

    const initial = await agg.load({ feed: "top", limit: 10 });
    expect(initial.articles[0]?.items).toEqual([]);

    const detail = await agg.loadStory("story-1");
    const state = agg.getQueryState({ feed: "top", limit: 10 });

    expect(detail?.items?.map((item) => item.id)).toEqual(["item-2", "item-1"]);
    expect(state.articles[0]?.items?.map((item) => item.id)).toEqual(["item-2", "item-1"]);
  });

  it("keeps story detail identity when a duplicate feed item wins ranking", async () => {
    const url = "https://detail.example.com/duplicate-story";
    const cloudArticle = makeItem({
      id: "story-1",
      url,
      importance: 60,
      publishedAt: new Date("2026-04-01T10:00:00.000Z"),
      items: [],
    });
    const feedDuplicate = makeItem({
      id: "rss-1",
      url,
      importance: 95,
      publishedAt: new Date("2026-04-01T10:05:00.000Z"),
    });
    const detailArticle = makeItem({
      ...cloudArticle,
      items: [{
        id: "item-1",
        sourceKey: "wire-a",
        sourceName: "Wire A",
        title: "Original",
        url: "https://detail.example.com/original",
        publishedAt: new Date("2026-04-01T10:00:00.000Z"),
      }],
    });

    agg.register({ ...makeStorySource("cloud", [cloudArticle], detailArticle), priority: 10 });
    agg.register({ ...makeSource("rss", [feedDuplicate]), priority: 2000 });

    const initial = await agg.load({ feed: "top", limit: 10 });

    expect(initial.articles[0]?.id).toBe("story-1");
    expect(initial.articles[0]?.importance).toBe(95);

    await agg.loadStory(initial.articles[0]!.id);
    const state = agg.getQueryState({ feed: "top", limit: 10 });

    expect(state.articles[0]?.items?.map((item) => item.id)).toEqual(["item-1"]);
  });

  it("appends paged news instead of replacing the first page", async () => {
    const first = makeItem({ url: "https://example.com/a", title: "First" });
    const second = makeItem({ url: "https://example.com/b", title: "Second" });
    const fetchNewsPage = mock(async (query: { cursor?: string }) => (
      query.cursor === "page-2"
        ? { articles: [second], nextCursor: null }
        : { articles: [first], nextCursor: "page-2" }
    ));
    agg.register(newsProvider({
      id: "cloud",
      name: "cloud",
      provider: {
        fetchNews: async (query) => (await fetchNewsPage(query)).articles,
        fetchNewsPage,
      },
    }));

    const initial = await agg.load({ feed: "latest", limit: 50 });
    expect(initial.articles.map((article) => article.url)).toEqual(["https://example.com/a"]);
    expect(initial.nextCursor).toBe("page-2");

    await agg.loadMore({ feed: "latest", limit: 50 });
    const state = agg.getQueryState({ feed: "latest", limit: 50 });
    expect(state.articles.map((article) => article.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(state.nextCursor).toBeNull();
  });
});
