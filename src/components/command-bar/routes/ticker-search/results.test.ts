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
  const search = (type: string) => ({ providerId: "gloom", symbol: "X", name: "X", exchange: "NYQ", type });
  expect(formatInstrumentBadge({ instrumentClass: "equity" })).toBe("EQ");
  expect(formatInstrumentBadge({ instrumentClass: "fund", result: search("ETF") })).toBe("ETF");
  expect(formatInstrumentBadge({ instrumentClass: "fund", result: search("ETN") })).toBe("ETF");
  expect(formatInstrumentBadge({ instrumentClass: "fund", result: search("MUTUALFUND") })).toBe("FUND");
  expect(formatInstrumentBadge({
    instrumentClass: "fund",
    ticker: { metadata: { ticker: "VTI", assetCategory: "ETF" } } as never,
  })).toBe("ETF");
  expect(formatInstrumentBadge({ instrumentClass: "derivative", result: search("Warrant") })).toBe("DERIV");
  // The class codes a query can end with (ES FUT) are the badges of the rows they keep.
  expect(formatInstrumentBadge({ instrumentClass: "derivative", result: search("FUTURE") })).toBe("FUT");
  expect(formatInstrumentBadge({ instrumentClass: "other", result: search("INDEX") })).toBe("IDX");
  expect(formatInstrumentBadge({ instrumentClass: "other", result: search("CRYPTOCURRENCY") })).toBe("CUR");
  expect(formatInstrumentBadge({ instrumentClass: "other", result: search("Unit") })).toBeUndefined();
});


test("plain exact-symbol search retains venue choices while deduplicating the same listing", () => {
  const items = [resultItem("gld:tsv", "GLD", "TSXV", "search"),
    resultItem("gld:nyse", "GLD", "NYSE", "search"), resultItem("gld:byma", "GLD", "BYMA", "search"),
    resultItem("gld:duplicate", "GLD", "XNYS", "search")];
  expect(mergePlainRootTickerResults("GLD", items, []).map((item) => item.id))
    .toEqual(["gld:tsv", "gld:nyse", "gld:byma"]);
});

test("an exact symbol keeps a row for each security before more exchanges of one, then looser hits", () => {
  const listing = (id: string, label: string, right: string, detail: string): ResultItem => ({
    ...resultItem(id, label, right, "search"), detail, badge: "EQ",
  });
  // Cloud's answer for SAP: SAP SE on nine venues, Saputo on Toronto last.
  const sapSe = ["NYSE", "XETRA", "XSTU", "FWB2", "VIE", "SWX", "MUNICH", "HANOVER", "BUD"]
    .map((venue) => listing(`sap:${venue}`, "SAP", venue, "SAP SE | Common Stock"));
  const providerItems = [
    ...sapSe,
    listing("sap:TSX", "SAP", "TSX", "Saputo Inc. | EQUITY"),
    listing("sapr", "SAPR", "IDX", "Saraswati Persada | Common Stock"),
  ];

  expect(mergePlainRootTickerResults("SAP", providerItems, []).map((item) => [item.id, item.category])).toEqual([
    ["sap:NYSE", "Exact Match"],
    ["sap:XETRA", "Exact Match"],
    ["sap:XSTU", "Exact Match"],
    ["sap:FWB2", "Exact Match"],
    ["sap:TSX", "Exact Match"],
  ]);
  // Fewer exact rows than the cap leave the rest to looser hits, as before.
  expect(mergePlainRootTickerResults("SAP", [sapSe[0]!, sapSe[1]!, providerItems.at(-1)!], [])
    .map((item) => item.id)).toEqual(["sap:NYSE", "sap:XETRA", "sapr"]);
});

test("one exchange is one exact row however the listing is spelled", () => {
  const items = [
    resultItem("saved:SAP", "SAP", "NYSE"),
    resultItem("saved:SAP:XETR", "SAP:XETR", "XETRA"),
    resultItem("search:XETRA", "SAP", "XETRA", "search"),
    resultItem("search:FWB2", "SAP", "FWB2", "search"),
  ];
  expect(mergePlainRootTickerResults("SAP", items, []).map((item) => item.id))
    .toEqual(["saved:SAP", "saved:SAP:XETR", "search:FWB2"]);
  // Cloud answers BRK.B and its BRK-B spelling with a row each for NYSE.
  const berkshire = [
    resultItem("dot:NYSE", "BRK.B", "NYSE", "search"),
    resultItem("dot:IEX", "BRK.B", "IEX", "search"),
    resultItem("dash:NYSE", "BRK-B", "NYSE", "search"),
    resultItem("compact:BMV", "BRKB", "BMV", "search"),
  ];
  expect(mergePlainRootTickerResults("BRK.B", berkshire, []).map((item) => item.id))
    .toEqual(["dot:NYSE", "dot:IEX", "compact:BMV"]);
});
