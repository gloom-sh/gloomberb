import { describe, expect, test } from "bun:test";
import { createTestArticle } from "../../../../test-support/news";
import {
  MAX_MUTED_KEYWORDS,
  NEWS_MUTED_KEYWORDS_KEY,
  NEWS_MUTED_SOURCES_KEY,
  applyNewsMutes,
  collectNewsSourceOptions,
  parseNewsMutedKeywords,
  parseNewsMutedSources,
  readNewsMutesFromPluginConfig,
} from "./mutes";

describe("parseNewsMutedSources", () => {
  test("trims, dedupes case-insensitively, and ignores junk", () => {
    expect(parseNewsMutedSources(["Spam Feed", " spam feed ", "", 42, "Other"]))
      .toEqual(["Spam Feed", "Other"]);
  });

});

describe("parseNewsMutedKeywords", () => {
  test("splits a comma-separated string, trims, and dedupes case-insensitively", () => {
    expect(parseNewsMutedKeywords("crypto, Earnings call;;crypto\n  fed "))
      .toEqual(["crypto", "Earnings call", "fed"]);
  });

  test("accepts string arrays and ignores junk", () => {
    expect(parseNewsMutedKeywords(["a,b", 3, "c"])).toEqual(["a", "b", "c"]);
    expect(parseNewsMutedKeywords(undefined)).toEqual([]);
  });

  test("caps runaway saved values", () => {
    const saved = Array.from({ length: 500 }, (_, index) => `keyword-${index}`).join(",");
    expect(parseNewsMutedKeywords(saved)).toHaveLength(MAX_MUTED_KEYWORDS);
  });
});

describe("readNewsMutesFromPluginConfig", () => {
  test("reads both mute keys from the news plugin config", () => {
    expect(readNewsMutesFromPluginConfig({
      [NEWS_MUTED_SOURCES_KEY]: ["Spam Feed"],
      [NEWS_MUTED_KEYWORDS_KEY]: "crypto, earnings",
    })).toEqual({ sources: ["Spam Feed"], keywords: ["crypto", "earnings"] });
  });

});

describe("news mute matching", () => {
  const spam = createTestArticle("spam", {
    source: "Spam Feed",
    title: "Penny stocks are back",
  });
  const earnings = createTestArticle("earnings", {
    title: "Quarterly EARNINGS call scheduled",
    summary: "Operators discuss the quarter.",
  });
  const clean = createTestArticle("clean", {
    title: "Fed holds rates steady",
    summary: "No earnings call in this headline.",
  });

  test("hides muted sources case-insensitively", () => {
    expect(applyNewsMutes([spam, earnings, clean], { sources: ["SPAM feed"], keywords: [] }).map((article) => article.id))
      .toEqual(["earnings", "clean"]);
  });

  test("hides headlines containing muted keywords case-insensitively", () => {
    expect(applyNewsMutes([spam, earnings, clean], { sources: [], keywords: ["earnings call"] }).map((article) => article.id))
      .toEqual(["spam", "clean"]);
  });

  test("matches keywords against the headline, not the summary", () => {
    const summaryOnly = createTestArticle("body", {
      title: "Fed holds rates",
      summary: "earnings call transcript",
    });
    expect(applyNewsMutes([summaryOnly], { sources: [], keywords: ["earnings call"] }).map((article) => article.id))
      .toEqual(["body"]);
  });

});

describe("collectNewsSourceOptions", () => {
  test("collects distinct sources from recent articles and keeps muted names with no stories", () => {
    const articles = [
      { source: "Reuters" },
      { source: "reuters" },
      { source: "Bloomberg" },
      { source: "  " },
      {},
    ];
    const options = collectNewsSourceOptions(articles, ["Spam Feed"]);
    expect(options.map((option) => option.value)).toEqual(["Bloomberg", "Reuters", "Spam Feed"]);
    expect(options.every((option) => option.label === option.value)).toBe(true);
  });

  test("keeps a muted source selectable when the article pool exceeds the cap", () => {
    const articles = Array.from({ length: 205 }, (_, index) => ({ source: `Source ${index}` }));
    const options = collectNewsSourceOptions(articles, ["Zeta Muted Feed"]);
    expect(options).toHaveLength(200);
    expect(options.some((option) => option.value === "Zeta Muted Feed")).toBe(true);
  });
});
