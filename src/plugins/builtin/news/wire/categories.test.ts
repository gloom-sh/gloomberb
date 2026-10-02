import { expect, test } from "bun:test";
import { createTestArticle } from "../../../../test-support/news";
import { enrichNewsItem } from "./categories";

function tickersOf(title: string, summary?: string): string[] {
  return enrichNewsItem(createTestArticle("rss", { title, summary })).tickers;
}

test("feed tickers come from cashtags, exchange pairs and brackets, bare only past two letters", () => {
  expect(tickersOf("NVDA and AMD rally as chip stocks rebound")).toEqual(["NVDA", "AMD"]);
  // One and two letter tickers are words and initials until marked as tickers.
  expect(tickersOf("Boston, MA startup raises seed round", "C suite pay and V-shaped recovery")).toEqual([]);
  expect(tickersOf("Visa (V) and Mastercard (NYSE: MA) settle", "$C slips")).toEqual(["V", "MA", "C"]);
  // A headline in capitals is not a list of tickers.
  expect(tickersOf("BREAKING: COST OF LIVING AND AMD INTEL NEWS AT IBM PARK")).toEqual([]);
  expect(tickersOf("Cost of living squeeze", "Retailers like COST watch margins")).toEqual([]);
});
