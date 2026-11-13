import { expect, test } from "bun:test";
import type { ResultItem } from "../../list/model";
import { buildTickerSearchCandidates } from "../../../../tickers/search";
import type { InstrumentSearchResult } from "../../../../types/instrument";
import { orderListResults } from "../../list/model";
import { exactMatchAfterCommands } from "../../view-model";
import { DID_YOU_MEAN_CATEGORY, formatInstrumentBadge, mergePlainRootTickerResults, mergeTickerSearchResultItems, readRootTickerQuery, venueDropdownResults, withMajorCoinCandidate, wordNamesCommand } from "./results";
import searchAnswers from "../../../../tickers/search/fixtures/search-answers-2026-11-13.json";

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

test("\"full\" runs Fullscreen Pane: a line that stopped trading goes last, and a word naming a command puts the command first", () => {
  const fullscreen = { ...resultItem("fullscreen", "Fullscreen Pane", "", "action"), category: "Focused Pane", searchText: "maximize maximise zoom", commandWords: ["fullscreen", "full", "maximize"] };
  const delisted = { ...resultItem("eq-full", "FULL", "NASDAQ", "search"), category: "Other Listings", stoppedTrading: true };
  const other = { ...resultItem("fuller", "FUL", "NYSE", "search"), category: "Other Listings" };
  // Research Search answers "full" by its "full text" keyword, ranked above the command by the bar's own matching.
  const research = { ...resultItem("research", "Research Search", "", "action"), category: "Panes", shortcutQuery: "SRCH", searchText: "full text" };
  const merged = mergePlainRootTickerResults("full", [delisted, other], [research, fullscreen]);
  // EQ FULL, last traded in 2016, is no exact match: it follows the other listings.
  expect(merged.map((item) => [item.id, item.category])).toEqual([
    ["fullscreen", "Focused Pane"], ["research", "Panes"], ["fuller", "Instruments"], ["eq-full", "Instruments"],
  ]);
  // A listing that trades keeps its exact match, under the command the word names when typed in small letters.
  const trading = { ...delisted, stoppedTrading: undefined };
  const rows = mergePlainRootTickerResults("full", [trading], [fullscreen]);
  expect(wordNamesCommand("full", [fullscreen])).toBe(true);
  expect(wordNamesCommand("maxim", [fullscreen])).toBe(true);
  expect(orderListResults(rows, { sectionOrder: "app-first", categoryPriorities: exactMatchAfterCommands() }).map((item) => item.id))
    .toEqual(["fullscreen", "eq-full"]);
  // Capitals are a ticker, and three letters are too few to name a command.
  expect(wordNamesCommand("FULL", [fullscreen])).toBe(false);
  expect(wordNamesCommand("ful", [fullscreen])).toBe(false);
  // A function's examples name no command: "nvda" is not EXPO's `NVDA=40%`.
  expect(wordNamesCommand("nvda", [{ ...resultItem("expo", "Exposure", "", "action"), shortcutQuery: "EXPO", searchText: "AAPL=60% NVDA=40%" }])).toBe(false);
  expect(orderListResults(rows, { sectionOrder: "app-first" }).map((item) => item.id)).toEqual(["eq-full", "fullscreen"]);
});

// The AI's rows repeat the word ("nvda · Ask Gloom", "NVDA · Open security details"), and any word of a function's name counted.
test("a lowercase ticker keeps its exact match beside the AI's rows, functions that merely contain it and actions that describe it", () => {
  for (const word of ["nvda", "tsla", "cash", "open", "team", "docu"]) {
    const bar = [
      { ...resultItem("ask", `${word} · Ask Gloom`, "", "action"), category: "Ask AI", searchChoice: { kind: "ask-gloom" as const } },
      { ...resultItem("assist", `${word.toUpperCase()} · Open security details`, "", "action"), category: "Ask AI", searchChoice: { kind: "assist" as const, input: `DES ${word}` } },
      { ...resultItem("pane-template:jobs:", `Jobs ${word} postings`, "", "action"), category: "Panes", searchText: `${word} hiring` },
      { ...resultItem("flow", "Fund Flows", "", "action"), category: "Panes", shortcutQuery: "FLOW", searchText: `${word} cash open` },
      // An action's label and search text describe it: "Hide Cash Positions" and "Open Brokers" name no ticker away.
      { ...resultItem("pane-setting:hideCash", "Hide Cash Positions", "", "action"), category: "Portfolio Pane Settings", searchText: `Portfolio Hide Cash Positions ${word}` },
      { ...resultItem("open-brokers", `${word[0]!.toUpperCase()}${word.slice(1)} Brokers`, "", "command"), category: "Broker", searchText: `Open Brokers ${word}` },
    ];
    expect(wordNamesCommand(word, bar), word).toBe(false);
    const listing = { ...resultItem("listing", word.toUpperCase(), "NASDAQ", "search"), category: "Other Listings" };
    expect(mergePlainRootTickerResults(word, [listing], bar)[0]?.category, word).toBe("Exact Match");
  }
});

test("an exact symbol that stopped trading stays first unless a live listing or a command answers the word", () => {
  const sivb = { ...resultItem("sivb", "SIVB", "NASDAQ", "search"), category: "Other Listings", stoppedTrading: true };
  const other = { ...resultItem("sivbq", "SIVBQ", "OTC", "search"), category: "Other Listings" };
  expect(mergePlainRootTickerResults("SIVB", [other, sivb], []).map((item) => [item.id, item.category]))
    .toEqual([["sivb", "Exact Match"], ["sivbq", "Instruments"]]);
  const live = { ...resultItem("sivb-live", "SIVB", "LSE", "search"), category: "Other Listings" };
  expect(mergePlainRootTickerResults("SIVB", [sivb, live], []).map((item) => [item.id, item.category]))
    .toEqual([["sivb-live", "Exact Match"], ["sivb", "Instruments"]]);
});

// Search sends no coin for BTC (or sends it last): the bar showed Grayscale's trust and four companies, never bitcoin.
test("a major coin's bare ticker offers the coin, first when the listing ahead cannot be it", () => {
  const listing = (symbol: string, name: string, exchange: string, type = "Common Stock"): InstrumentSearchResult => (
    { providerId: "gloomberb-cloud", symbol, name, exchange, type }
  );
  const order = (query: string, results: InstrumentSearchResult[]) => withMajorCoinCandidate(
    query,
    buildTickerSearchCandidates({ query, tickers: new Map(), providerResults: results, totalLimit: 30 }),
    new Map(),
  ).map((candidate) => `${candidate.symbol}:${candidate.result?.exchange}`);

  // A fund named for the coin cannot be it: the coin leads, the row search sent last moving up.
  expect(order("BTC", [
    listing("BTC", "Grayscale Bitcoin Mini Trust ETF", "ARCA", "ETF"),
    listing("BTC", "BTC Health Ltd.", "CXA"),
    listing("BTC-USD", "Bitcoin USD", "CCC", "CRYPTOCURRENCY"),
  ]).slice(0, 2)).toEqual(["BTC-USD:CCC", "BTC:ARCA"]);
  // A live company of those letters keeps the lead; the coin, which search did not send, follows it.
  expect(order("LINK", [listing("LINK", "Interlink Electronics, Inc.", "NASDAQ"), listing("LINK", "Link Net Tbk.", "JAKARTA")]))
    .toEqual(["LINK:NASDAQ", "LINK-USD:CCC", "LINK:JAKARTA"]);
  expect(order("AAPL", [listing("AAPL", "Apple Inc.", "NASDAQ")])).toEqual(["AAPL:NASDAQ"]);

  const rows = mergeTickerSearchResultItems("BTC", [
    { ...resultItem("coin", "BTC-USD", "CCC", "search"), category: "Other Listings", instrumentType: "CRYPTOCURRENCY" },
    { ...resultItem("pair", "BCH-USD", "CCC", "search"), category: "Other Listings", instrumentType: "CRYPTOCURRENCY" },
  ], []);
  expect(rows.map((row) => row.category)).toEqual(["Exact Match", "Other Listings"]);
});

test("an index typed by its code is the exact match; the fund named for it and a name search are not", () => {
  const rows = (query: string) => mergeTickerSearchResultItems(query, [
    { ...resultItem("index", "^BVSP", "B3", "search"), detail: "Ibovespa", category: "Primary Listing", instrumentType: "INDEX", searchAliases: ["^BVSP", "IBOV", "IBOV Index"] },
    { ...resultItem("fund", "IBOV11", "B3", "search"), detail: "IBOV11 Fund", category: "Other Listings", instrumentType: "Common Stock", searchAliases: ["IBOV11"] },
  ], []);
  for (const query of ["IBOV", "ibov", "IBOV Index"]) {
    expect(rows(query).map((item) => [item.id, item.category]), query).toEqual([["index", "Exact Match"], ["fund", "Other Listings"]]);
  }
  expect(rows("ibovespa")[0]?.category).toBe("Primary Listing");
  const pane: ResultItem = { id: "pane:news", label: "News", detail: "", category: "Panes", kind: "action", action: () => {} };
  expect(mergePlainRootTickerResults("IBOV", rows("IBOV"), [pane]).map((item) => [item.id, item.category])).toEqual([
    ["index", "Exact Match"],
    ["pane:news", "Panes"],
    ["fund", "Instruments"],
  ]);
});

test("a commodity typed by its name is the exact match with its benchmark future first; a name search is not", () => {
  const rows = (query: string) => mergeTickerSearchResultItems(query, [
    { ...resultItem("future", "GC=F", "CMX", "search"), detail: "Gold", category: "Funds & Derivatives", instrumentType: "FUTURE", searchAliases: ["GC=F", "Gold"] },
    { ...resultItem("company", "GOLD", "NYSE", "search"), detail: "Gold.com, Inc.", category: "Primary Listing", instrumentType: "Common Stock", searchAliases: ["GOLD"] },
  ], []);
  for (const query of ["gold", "Gold", "GOLD"]) {
    expect(rows(query).map((item) => [item.id, item.category]), query).toEqual([["future", "Exact Match"], ["company", "Exact Match"]]);
  }
  expect(rows("gold futures").map((item) => [item.id, item.category])).toEqual([["future", "Exact Match"], ["company", "Primary Listing"]]);
  expect(rows("gold miners").map((item) => item.category)).toEqual(["Funds & Derivatives", "Primary Listing"]);
  const pane: ResultItem = { id: "pane:news", label: "News", detail: "", category: "Panes", kind: "action", action: () => {} };
  expect(mergePlainRootTickerResults("gold", rows("gold"), [pane]).map((item) => item.id)).toEqual(["future", "company", "pane:news"]);
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

test("a plain query with no instruments keeps a busy or failed search's row, and drops a no-match one", () => {
  const pane: ResultItem = { id: "pane:news", label: "News", detail: "", category: "Panes", kind: "action", action: () => {} };
  const ids = (providerItems: ResultItem[]) => mergePlainRootTickerResults("semiconductor etf", providerItems, [pane]).map((item) => item.id);
  // A search that did not answer must not read as one that found nothing.
  expect(ids([resultItem("search-busy", "Search is busy", "", "info")])).toEqual(["pane:news", "search-busy"]);
  expect(ids([resultItem("search-error", "Search failed", "", "info")])).toEqual(["pane:news", "search-error"]);
  // One that found nothing leaves the list to say so.
  expect(ids([resultItem("no-results", "No matches", "", "info")])).toEqual(["pane:news"]);
});

test("a listing the server marks with the name as typed is an exact match beside the ticker's: 0005 for hsbc", () => {
  const row = (id: string, label: string, right: string, searchAliases?: string[]): ResultItem =>
    ({ ...resultItem(id, label, right, "search"), ...(searchAliases ? { searchAliases } : {}) });
  const merged = mergePlainRootTickerResults("hsbc", [
    row("hsbc-nyse", "HSBC", "NYSE"),
    row("hsba", "HSBA", "LSE", ["HSBA", "hsbc"]),
    row("hsbc-iex", "HSBC", "IEX"),
    row("0005", "0005", "HKEX", ["0005", "5", "hsbc"]),
    row("hbcyf", "HBCYF", "OTC"),
  ], []);
  expect(merged.filter((item) => item.category === "Exact Match").map((item) => item.id)).toEqual(["hsbc-nyse", "hsba", "hsbc-iex", "0005"]);
  // A saved listing search marked for the name is one too: MSFT, saved, for "micro".
  const saved: ResultItem = { ...resultItem("goto:MSFT", "MSFT", "NASDAQ"), searchAliases: ["MSFT", "micro"] };
  expect(mergePlainRootTickerResults("micro", [saved, row("micro", "MICRO", "SET")], []).map((item) => [item.id, item.category]))
    .toEqual([["goto:MSFT", "Exact Match"], ["micro", "Exact Match"]]);
});

test("each line the server marks with the word is a row of its own, not a further venue of the company's first: ccb's 0939 beside its 601939", () => {
  const query = "ccb";
  const items = buildTickerSearchCandidates({
    query, tickers: new Map(), providerResults: searchAnswers.answers.ccb as InstrumentSearchResult[], totalLimit: 30,
  }).map((candidate): ResultItem => ({
    ...resultItem(candidate.id, candidate.label, candidate.exchangeLabel ?? "", "search"),
    detail: candidate.detail, category: candidate.category, instrumentType: candidate.instrumentType,
    searchAliases: candidate.searchAliases, badge: formatInstrumentBadge(candidate),
  }));
  const merged = mergePlainRootTickerResults(query, mergeTickerSearchResultItems(query, items, []), []);
  // China Construction Bank's Hong Kong line, in the service's order, ahead of the other CCBs' further companies.
  expect(merged.map((item) => `${item.label}:${item.right}`)).toEqual(["CCB:NASDAQ", "601939:SSE", "0939:HKEX", "CCB:FWB2", "CCB:BVC"]);
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
  expect(formatInstrumentBadge({ instrumentClass: "fund", result: search("Closed-end Fund") })).toBe("FUND");
  expect(formatInstrumentBadge({ instrumentClass: "other", result: search("MONEY_MARKET") })).toBe("FUND");
  expect(formatInstrumentBadge({
    instrumentClass: "fund",
    ticker: { metadata: { ticker: "VTI", assetCategory: "ETF" } } as never,
  })).toBe("ETF");
  expect(formatInstrumentBadge({ instrumentClass: "derivative", result: search("Warrant") })).toBe("DERIV");
  // The class codes a query can end with (ES FUT) are the badges of the rows they keep.
  expect(formatInstrumentBadge({ instrumentClass: "derivative", result: search("FUTURE") })).toBe("FUT");
  expect(formatInstrumentBadge({ instrumentClass: "other", result: search("INDEX") })).toBe("IDX");
  expect(formatInstrumentBadge({ instrumentClass: "other", result: search("CRYPTOCURRENCY") })).toBe("CRYP");
  expect(formatInstrumentBadge({ instrumentClass: "other", result: search("Unit") })).toBeUndefined();
});


test("a colon dropdown is one exact venue per row, narrowed by the exchange prefix", () => {
  const items = [
    resultItem("lse", "NET", "LSE", "search"),
    resultItem("nyse", "NET", "NYSE", "search"),
    resultItem("lookalike", "NETE", "NASDAQ", "search"),
    resultItem("command", "NET", "DES", "command"),
  ];
  expect(venueDropdownResults("NET", items, "").map((item) => [item.id, item.category])).toEqual([
    ["lse", "Exact Match"],
    ["nyse", "Exact Match"],
  ]);
  expect(venueDropdownResults("NET", items, "N").map((item) => item.right)).toEqual(["NYSE"]);
  expect(venueDropdownResults("NET", items, "X").map((item) => item.right)).toEqual(["LSE", "NYSE"]);
  expect(venueDropdownResults("NET", items, "LON").map((item) => item.right)).toEqual(["LSE"]);
  // EURUSD:FX and EURUSD:CCY pick the pair search lists on the currency venue.
  const pairs = [resultItem("eurusd", "EURUSD=X", "CCY", "search"), resultItem("fund", "EURUSD", "LSE", "search")];
  for (const suffix of ["FX", "CCY", ""]) {
    expect(venueDropdownResults("EURUSD", pairs, suffix).map((item) => item.id), suffix).toEqual(suffix ? ["eurusd"] : ["eurusd", "fund"]);
  }
  expect(venueDropdownResults("USDJPY", [resultItem("jpy", "JPY=X", "CCY", "search")], "FX").map((item) => item.id)).toEqual(["jpy"]);
  // A search that did not answer says so in the dropdown too, rather than leave it reading as no venue.
  expect(venueDropdownResults("NET", [resultItem("search-error", "Search failed", "", "info")], "").map((item) => item.id)).toEqual(["search-error"]);
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

test("a Bloomberg code's listing is the exact match; an unknown market code or a near miss offers the row it was read from above Ask AI", () => {
  const search = (id: string, label: string, right: string): ResultItem => ({ ...resultItem(id, label, right, "search"), category: "Other Listings" });
  const ask: ResultItem = { id: "ask", label: "Ask AI", detail: "", category: "Ask AI", kind: "action", action: () => {} };
  const merged = (query: string, rows: ResultItem[]) => mergePlainRootTickerResults(readRootTickerQuery(query)!.search, rows, [ask], readRootTickerQuery(query))
    .map((item) => [item.id, item.category]);
  const vod = [search("adr", "VOD", "NASDAQ"), search("lse", "VOD", "LSE"), search("xetra", "VODI", "XETRA")];
  expect(merged("VOD LN", vod)).toEqual([["lse", "Exact Match"], ["ask", "Ask AI"], ["adr", "Instruments"], ["xetra", "Instruments"]]);
  expect(merged("VOD US Equity", vod)[0]).toEqual(["adr", "Exact Match"]);
  // Search lists Volvo's B shares as VOLV.B, the code glues the class on.
  expect(merged("VOLVB SS", [search("prague", "VOLVB", "PSE"), search("sto", "VOLV.B", "SFB")])[0]).toEqual(["sto", "Exact Match"]);
  const apple = [search("aapl", "AAPL", "NASDAQ"), search("other", "AAPLUSTRAD", "BSE")];
  for (const query of ["AAPL GY", "AAPL GP"]) {
    expect(merged(query, apple), query).toEqual([["aapl", DID_YOU_MEAN_CATEGORY], ["ask", "Ask AI"], ["other", "Instruments"]]);
  }
  expect(merged("700.HK", [search("tencent", "0700", "HKEX")])[0]).toEqual(["tencent", DID_YOU_MEAN_CATEGORY]);
  expect(merged("6758.JP", [search("sony", "6758", "JPX")])[0]).toEqual(["sony", DID_YOU_MEAN_CATEGORY]);
  expect(merged("BRK/B", [search("brk", "BRK.B", "NYSE")])[0]).toEqual(["brk", DID_YOU_MEAN_CATEGORY]);
  // A name before a legal form is searched as typed, so search finds the company: SE is also SIX Swiss's code.
  for (const query of ["AAPL", "apple", "VOD.L", "AAPL MSFT", "vod ln", "SAP SE", "SIEMENS AG", "P/E"]) expect(readRootTickerQuery(query), query).toBeNull();
});
