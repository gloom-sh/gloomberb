import { expect, test } from "bun:test";
import type { ResultItem } from "../../list/model";
import { mergeTickerSearchResultItems } from "./results";

function resultItem(id: string, label: string, right: string, kind: ResultItem["kind"] = "ticker"): ResultItem {
  return {
    id,
    label,
    detail: "Apple Inc.",
    category: kind === "info" ? "Search" : "Saved",
    kind,
    right,
    action: () => {},
  };
}

test("keeps completed ticker-search results authoritative over provisional rows", () => {
  const authoritative = [
    resultItem("ranked:AAPL", "AAPL", "Equity NASDAQ"),
    resultItem("ranked:APC", "APC", "Equity XETRA"),
  ];
  const provisional = [
    resultItem("local:APC", "APC", "Equity XETRA"),
    resultItem("local:AAPL", "AAPL", "Equity NASDAQ"),
  ];

  expect(mergeTickerSearchResultItems("Apple", authoritative, provisional).map((item) => item.id)).toEqual([
    "ranked:AAPL",
    "ranked:APC",
  ]);

  const noResults = resultItem("no-results", "No matches for Apple", "", "info");
  expect(mergeTickerSearchResultItems("Apple", [noResults], [])).toEqual([noResults]);
});
