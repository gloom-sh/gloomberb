import { expect, test } from "bun:test";
import { createTestArticle } from "../../../../test-support/news";
import { filterNewsArticles } from "./filter-articles";

test("excludes a headline that does not match the query", () => {
  const articles = [
    createTestArticle("keep", {
      title: "Fed holds rates steady",
      source: "Wire",
      tickers: ["SPY"],
    }),
    createTestArticle("drop", {
      title: "Chip supply tightens",
      source: "Wire",
      tickers: ["NVDA"],
    }),
  ];
  expect(filterNewsArticles(articles, "fed").map((article) => article.id)).toEqual(["keep"]);
});
