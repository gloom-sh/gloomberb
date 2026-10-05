import { describe, expect, test } from "bun:test";
import type { NewsService } from "../../../../../news/aggregator";
import type { NewsArticle, NewsQuery } from "../../../../../news/types";
import { createTestArticle } from "../../../../../test-support/news";
import { createLoadedStorySearchProvider, matchLoadedStories } from "./command-bar-search";

const hormuz = createTestArticle("hormuz", {
  title: "Tankers wait as the Strait of Hormuz stays shut",
  source: "FT",
  publishedAt: new Date("2026-10-05T09:00:00Z"),
});
const author = createTestArticle("author", {
  title: "Author warns of a chip shortage",
  publishedAt: new Date("2026-10-05T10:00:00Z"),
});
const apple = createTestArticle("apple", {
  title: "iPhone sales beat estimates",
  tickers: ["AAPL"],
  publishedAt: new Date("2026-10-04T10:00:00Z"),
});

describe("matchLoadedStories", () => {
  test("matches word prefixes, not letters inside words", () => {
    expect(matchLoadedStories([hormuz, author, apple], "hor").map((article) => article.id)).toEqual(["hormuz"]);
  });

  test("every word has to match, tickers count, one-letter words are ignored", () => {
    expect(matchLoadedStories([hormuz, author, apple], "aapl iphone").map((article) => article.id)).toEqual(["apple"]);
    expect(matchLoadedStories([apple, hormuz, author], "a").map((article) => article.id)).toEqual([]);
    expect(matchLoadedStories([apple, hormuz], "strait hormuz").map((article) => article.id)).toEqual(["hormuz"]);
    const dollars = createTestArticle("dollars", { title: "Brent tops $100", tickers: ["AAPL"] });
    expect(matchLoadedStories([dollars], "AAPL 10-K")).toEqual([]);
  });
});

function fakeService(initial: NewsArticle[], latest: NewsArticle[]) {
  let pool = initial;
  const loads: NewsQuery[] = [];
  const service = {
    listArticles: () => pool,
    getQueryState: () => ({ articles: pool.filter((article) => latest.includes(article)) }),
    load: async (query: NewsQuery) => {
      loads.push(query);
      pool = [...pool, ...latest];
    },
  };
  return { service: service as unknown as NewsService, loads };
}

describe("the loaded-story lookup provider", () => {
  const context = { activeTicker: null, activeCollectionId: null };
  const signal = new AbortController().signal;

  test("signed out, loads the latest feed once, then lists matching stories", async () => {
    const { service, loads } = fakeService([], [hormuz, author]);
    const opened: unknown[] = [];
    const provider = createLoadedStorySearchProvider(
      { createPaneFromTemplate: (templateId, options) => { opened.push([templateId, options]); } },
      { getService: () => service, isSignedIn: () => false, now: () => Date.parse("2026-10-05T12:00:00Z") },
    );

    const rows = await provider.provide("hormuz", context, signal);
    expect(rows.map((row) => [row.label, row.detail])).toEqual([[hormuz.title, "FT"]]);
    await provider.provide("author", context, signal);
    expect(loads).toEqual([{ feed: "latest", limit: 200 }]);

    await rows[0]!.execute();
    expect(opened).toEqual([["news-story-pane", { arg: "hormuz", values: { title: hormuz.title } }]]);
  });

  test("signed in, leaves the News section to the corpus search", async () => {
    const { service, loads } = fakeService([hormuz], [hormuz]);
    const provider = createLoadedStorySearchProvider(
      { createPaneFromTemplate: () => {} },
      { getService: () => service, isSignedIn: () => true, now: Date.now },
    );
    expect(await provider.provide("hormuz", context, signal)).toEqual([]);
    expect(loads).toEqual([]);
  });
});
