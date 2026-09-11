import { expect, test } from "bun:test";
import type { ResultItem } from "../../list/model";
import { formatInstrumentBadge, mergePlainRootTickerResults, mergeTickerSearchResultItems } from "./results";

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

test("exact-match categories preserve a requested listing's venue", () => {
  const items = mergeTickerSearchResultItems("VOD.L", [
    { ...resultItem("london", "VOD", "LSE", "search"), category: "Other Listings" },
    { ...resultItem("cboe", "VODL", "CBOE", "search"), category: "Other Listings" },
  ], []);
  expect(items[0]?.category).toBe("Exact Match");
  expect(items[1]?.category).not.toBe("Exact Match");
});

test("exact-match promotion never treats a futures or FX spelling as an equity", () => {
  for (const [query, lookalike] of [["ES=F", "ESF"], ["EUR/USD", "EURUSD"], ["JPY=X", "JPYX"]]) {
    const rows = mergeTickerSearchResultItems(query!, [
      { ...resultItem("equity", lookalike!, "MTA", "search"), category: "Other Listings" },
      { ...resultItem("market", query!, "", "search"), category: "Other Listings" },
    ], []);
    expect(rows[0]?.category).not.toBe("Exact Match");
    expect(rows[1]?.category).toBe("Exact Match");
    expect(mergePlainRootTickerResults(query!, rows, [resultItem("pane", "Research", "", "action")])[0]?.id)
      .toBe("market");
  }
});

test("crypto punctuation aliases never outrank the verified exact symbol in command results", () => {
  const rows = mergeTickerSearchResultItems("SHIB-USD", [
    { ...resultItem("alias", "SHIB/USD", "COINBASE PRO", "search"), category: "Other Listings", instrumentType: "Digital Currency" },
    { ...resultItem("exact", "SHIB-USD", "CCC", "search"), category: "Other Listings", instrumentType: "CRYPTOCURRENCY" },
  ], []);
  expect(rows[0]?.category).not.toBe("Exact Match");
  expect(rows[1]?.category).toBe("Exact Match");
  expect(mergePlainRootTickerResults("SHIB-USD", rows, [resultItem("pane", "Research", "", "action")])[0]?.id).toBe("exact");
});

test("folds a plain query's symbol hits into one capped Instruments section behind the local rows", () => {
  const pane: ResultItem = {
    id: "pane:news",
    label: "News",
    detail: "",
    category: "Panes",
    kind: "action",
    action: () => {},
  };
  const providerItems = [
    resultItem("search:NVDA", "NVDA", "NASDAQ", "search"),
    // The saved row for the same symbol carries a different badge; one row per symbol.
    resultItem("goto:NVDA", "NVDA", "NASDAQ"),
    resultItem("search:NVDA.MX", "NVDA.MX", "Equity BMV", "search"),
    resultItem("search:NVD.DE", "NVD.DE", "Equity XETRA", "search"),
    resultItem("search:NVDL", "NVDL", "Fund NASDAQ", "search"),
    resultItem("search:NVDS", "NVDS", "Fund NASDAQ", "search"),
    resultItem("search:NVDX", "NVDX", "Fund NASDAQ", "search"),
    resultItem("search-error", "Search failed", "", "info"),
  ];

  const merged = mergePlainRootTickerResults("nvda", providerItems, [pane]);

  expect(merged.map((item) => [item.id, item.category])).toEqual([
    ["search:NVDA", "Exact Match"],
    ["pane:news", "Panes"],
    ["search:NVDA.MX", "Instruments"],
    ["search:NVD.DE", "Instruments"],
    ["search:NVDL", "Instruments"],
    ["search:NVDS", "Instruments"],
  ]);
  expect(merged.find((item) => item.id === "search:NVDA.MX")?.right).toBe("Equity BMV");
});

/**
 * The class tag is what the eye sorts instruments by, so the mapping from a
 * provider's type strings has to stay put: an exchange-traded fund is not a
 * mutual fund, and an unclassified instrument gets no tag rather than a stand-in.
 */
test("names the instrument class for the badge column", () => {
  const search = (type: string) => ({ providerId: "yahoo", symbol: "X", name: "X", exchange: "NYQ", type });
  expect(formatInstrumentBadge({ instrumentClass: "equity" })).toBe("EQ");
  expect(formatInstrumentBadge({ instrumentClass: "fund", result: search("ETF") })).toBe("ETF");
  expect(formatInstrumentBadge({ instrumentClass: "fund", result: search("ETN") })).toBe("ETF");
  expect(formatInstrumentBadge({ instrumentClass: "fund", result: search("MUTUALFUND") })).toBe("FUND");
  expect(formatInstrumentBadge({
    instrumentClass: "fund",
    ticker: { metadata: { ticker: "VTI", assetCategory: "ETF" } } as never,
  })).toBe("ETF");
  expect(formatInstrumentBadge({ instrumentClass: "derivative" })).toBe("DERIV");
  expect(formatInstrumentBadge({ instrumentClass: "other", result: search("INDEX") })).toBeUndefined();
});


test("plain exact-symbol search retains venue choices while deduplicating the same listing", () => {
  const items = [resultItem("gld:tsv", "GLD", "TSXV", "search"),
    resultItem("gld:nyse", "GLD", "NYSE", "search"), resultItem("gld:byma", "GLD", "BYMA", "search"),
    resultItem("gld:duplicate", "GLD", "XNYS", "search")];
  expect(mergePlainRootTickerResults("GLD", items, []).map((item) => item.id))
    .toEqual(["gld:tsv", "gld:nyse", "gld:byma"]);
});
