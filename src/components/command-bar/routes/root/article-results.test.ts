import { describe, expect, test } from "bun:test";
import type { NewsArticle } from "../../../../news/types";
import { buildArticleSearchResultItems } from "./article-results";
import { isArticleLookupShortcut } from "./results";

function article(title: string, source: string): NewsArticle {
  return {
    id: title,
    title,
    source,
    url: `https://example.com/${title}`,
    publishedAt: new Date("2026-08-14T12:00:00Z"),
    topic: "general",
    topics: [],
    sectors: [],
    categories: [],
    tickers: [],
    scores: { importance: 50, urgency: 0, marketImpact: 0, novelty: 0, confidence: 0 },
    isBreaking: false,
    isDeveloping: false,
    importance: 50,
  };
}

describe("buildArticleSearchResultItems", () => {
  test("offers the matching article to open", () => {
    const opened: string[] = [];
    const items = buildArticleSearchResultItems({
      articles: [
        article("Iran Threatens to Close the Strait of Hormuz", "Reuters"),
        article("Fed holds rates", "CNBC Top News"),
      ],
      query: "article on the strait",
      phase: "ready",
      onOpen: (item) => {
        opened.push(item.id);
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.label).toContain("Hormuz");
    expect(items[0]?.detail).toBe("Reuters");
    items[0]?.action();
    expect(opened).toEqual(["Iran Threatens to Close the Strait of Hormuz"]);
  });

  test("shows typo-tolerant cloud matches without re-filtering them locally", () => {
    const items = buildArticleSearchResultItems({
      articles: [],
      cloudArticles: [article("Microsoft announces new cloud region", "Reuters")],
      query: "ART mikrosoft",
      phase: "ready",
      onOpen: () => {},
    });
    expect(items.map((item) => item.label)).toEqual([
      "Microsoft announces new cloud region",
    ]);
  });

  test("shows a lookup row while subscribed feeds are still loading", () => {
    const items = buildArticleSearchResultItems({
      articles: [],
      query: "article on the strait",
      phase: "loading",
      onOpen: () => {},
    });
    expect(items.map((item) => item.label)).toEqual(["Looking up articles…"]);
  });

  test("returns local matches without waiting on a still-loading lookup", () => {
    const items = buildArticleSearchResultItems({
      articles: [article("Trump administration pauses talks", "AP")],
      query: "ART trum",
      phase: "loading",
      onOpen: () => {},
    });
    expect(items.map((item) => item.label)).toEqual(["Trump administration pauses talks"]);
  });
});

describe("isArticleLookupShortcut", () => {
  test("treats the ART plugin command as an article lookup", () => {
    expect(isArticleLookupShortcut({ kind: "none" })).toBe(false);
    expect(isArticleLookupShortcut({
      kind: "partial",
      source: "plugin-command",
      prefix: "ART",
      label: "Open Article",
      description: "",
      argKind: "text",
      argText: "hormuz",
      completionQuery: null,
      command: { id: "open-news-article", label: "Open Article" } as never,
    })).toBe(true);
  });
});
