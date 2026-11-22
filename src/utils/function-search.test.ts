import { expect, test } from "bun:test";
import { fuzzyFilter } from "./fuzzy-search";
import { matchesFunctionPhrase, matchesFunctionSearch, paneTemplateSearchFields } from "./function-search";

test("function lookup reads aliases, vocabulary and stems as words", () => {
  const entries = [
    { id: "gr", paneId: "gr", label: "Relationship Graph", description: "Scatter plot", shortcut: { prefix: "GR", aliases: ["BETA"] } },
    { id: "cmp", paneId: "cmp", label: "Comparison Chart", description: "Rebased performance", keywords: ["total returns"], shortcut: { prefix: "CMP" } },
    { id: "fut", paneId: "fut", label: "Market Board", description: "Front contracts", keywords: ["futures"], shortcut: { prefix: "FUT" } },
  ];
  for (const [query, expected] of [["beta", "gr"], ["BETA", "gr"], ["compare", "cmp"], ["compare for total return", "cmp"], ["futures", "fut"]] as const) {
    const fields = entries.filter((entry) => matchesFunctionSearch(query, paneTemplateSearchFields(entry)));
    expect(fields.map((entry) => entry.id)).toEqual([expected]);
    expect(fuzzyFilter(entries, query, (entry) => paneTemplateSearchFields(entry).join(" "), undefined, () => true).map((entry) => entry.id)).toEqual([expected]);
  }
  expect(matchesFunctionSearch("total return xylophone", paneTemplateSearchFields(entries[1]!))).toBeFalse();
  expect(matchesFunctionPhrase("a separate calculation", "rate")).toBeFalse();
});
