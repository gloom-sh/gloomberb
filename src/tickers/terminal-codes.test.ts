import { expect, test } from "bun:test";
import { applyListingArgument } from "../cli/pane-functions/resolver";
import { parsePaneFunctionArgs } from "../cli/pane-functions/options";
import type { PaneFunctionCatalog } from "../cli/pane-functions/catalog";
import type { MarketContext } from "../cli/types";
import { parseListingArg, resolveCliListing } from "../cli/listing-arg";
import { createTestDataProvider } from "../test-support/data-provider";
import type { InstrumentSearchResult } from "../types/instrument";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../types/plugin";
import { normalizeTickerInput } from "./search";
import { BLOOMBERG_MARKETS, readNearMissListing, readTerminalListingCode, unknownBloombergMarket } from "./terminal-codes";
import { isKnownExchangeCode } from "../utils/exchanges";
import { splitSymbolArgs, splitSymbolWords } from "../cli/symbol-args";
import { parseSymbolText } from "../cli/symbol-list";

test.each([
  ["WFC.N", "WFC:NYSE"],
  ["wfc.n", "WFC:NYSE"],
  ["AAPL.O", "AAPL:NASDAQ"],
  ["AAPL.OQ", "AAPL:NASDAQ"],
  ["BRKb.N", "BRK.B:NYSE"],
  ["JPM US Equity", "JPM"],
  ["jpm  us  equity", "JPM"],
  ["JPM US", "JPM"],
  ["JPM UN Equity", "JPM:NYSE"],
  ["BRK/B US Equity", "BRK.B"],
  ["MC FP", "MC:EPA"],
  ["VOD LN Equity", "VOD:LSE"],
  ["vod ln equity", "VOD:LSE"],
  ["7203 JP", "7203:JPX"],
  ["CSL AU", "CSL:ASX"],
  // Hong Kong drops the leading zeros, the China composite is Shanghai for a 6 and Shenzhen otherwise.
  ["700 HK", "0700:HKEX"],
  ["600519 CH", "600519:SSE"],
  ["000001 CH Equity", "000001:SZSE"],
  ["BT/A LN", "BT.A:LSE"],
  ["SPX Index", "^GSPC"],
  ["ES1 Index", "ES1E"],
  ["EURUSD Curncy", "EURUSD=X"],
  ["JPY Curncy", "USDJPY=X"],
  ["EUR Curncy", "EURUSD=X"],
  ["CL1 Comdty", "CL1E"],
  ["CO1 Comdty", "CO1E"],
])("a terminal's code %s is the listing %s", (typed, key) => {
  expect(readTerminalListingCode(typed)?.key).toBe(key);
  expect(parseListingArg(typed).key).toBe(key);
  expect(normalizeTickerInput(null, typed)).toBe(key);
});

test.each(["VOD.L", "7203.T", "RY.TO", "0700.HK", "BRK.B", "BRK.A", "Wells Fargo", "AAPL MSFT", "vod ln", "Apple Co", "XYZ Index", "Gold Comdty", "USD Curncy", "CLZ6 Comdty"])(
  "%s is not a terminal's code and parses as before",
  (typed) => {
    expect(readTerminalListingCode(typed)).toBeNull();
    expect(parseListingArg(typed).readAs).toBeUndefined();
  },
);

test("every market code reads as a venue of the shared exchange table, on its own and with the Equity key", () => {
  for (const [code, market] of Object.entries(BLOOMBERG_MARKETS)) {
    for (const venue of market.venues) expect(venue === "" || isKnownExchangeCode(venue), `${code} ${venue}`).toBe(true);
    const read = readTerminalListingCode(`ABC ${code}`);
    expect(read?.market, code).toBe(code);
    expect(readTerminalListingCode(`ABC ${code} Equity`)?.key, code).toBe(read!.key);
    expect(read!.exchange, code).toBe(market.local === "china" ? "SZSE" : market.venues[0]);
    // A venue is written as `SYM:EXCH` names it, so a code and a typed key are one listing.
    expect(parseListingArg(read!.key).exchange, code).toBe(read!.exchange);
  }
  expect(Object.keys(BLOOMBERG_MARKETS)).toEqual(expect.arrayContaining([
    "LN", "GY", "GR", "FP", "SW", "NA", "IM", "SM", "SS", "DC", "NO", "FH", "JP", "JT", "HK", "KS", "CH", "TT", "AU", "IN", "CN",
  ]));
});

test("a code that names several listings lists the others to try after the first", () => {
  // Bloomberg glues a Nordic class on (VOLVB); ABB and NOKIA end in a letter too, so the code as written goes first.
  expect(readTerminalListingCode("VOLVB SS")).toMatchObject({ key: "VOLVB:SFB", alternatives: [{ key: "VOLV.B:SFB" }] });
  expect(readTerminalListingCode("ABB SS")?.key).toBe("ABB:SFB");
  expect(readTerminalListingCode("RY CN")).toMatchObject({ key: "RY:TSX", alternatives: [{ key: "RY:TSXV" }] });
});

test("words written as a code with a market code no venue answers to are one refused entry; a name is not", () => {
  expect(unknownBloombergMarket("AAPL GP")).toEqual({ typed: "AAPL GP", symbol: "AAPL", market: "GP", keyed: false });
  expect(unknownBloombergMarket("KO PG")).toMatchObject({ symbol: "KO", market: "PG" });
  expect(unknownBloombergMarket("aapl zz equity")).toMatchObject({ symbol: "AAPL", market: "ZZ", keyed: true });
  for (const typed of ["Apple Co", "aapl gp", "VOD LN", "AAPL MSFT", "AAPL GP MSFT", "SPX Index"]) expect(unknownBloombergMarket(typed), typed).toBeNull();
  // A list line, typed or a file's, is one entry: never AAPL and GP.
  expect(splitSymbolArgs(["AAPL GP"])).toEqual(["AAPL GP"]);
  expect(splitSymbolArgs(["MC FP"])).toEqual(["MC FP"]);
  expect(splitSymbolWords(["VOD LN", "AAPL MSFT"])).toEqual(["VOD LN", "AAPL", "MSFT"]);
  expect(parseSymbolText("MC FP\nAIR FP\nAAPL GP\n").symbols).toEqual(["MC FP", "AIR FP", "AAPL GP"]);
});

test.each([
  ["700.HK", "0700.HK"],
  ["6758.JP", "6758.T"],
  ["BRK/B", "BRK-B"],
  ["MC.FP", "MC.PA"],
])("%s, written nearly as a listing, reads as %s", (typed, symbol) => {
  expect(readNearMissListing(typed)?.symbol).toBe(symbol);
  expect(parseListingArg(typed)).toMatchObject({ key: symbol, readAs: `Read ${typed} as ${symbol}.` });
  expect(normalizeTickerInput(null, typed)).toBe(symbol);
});

// A listing suffix already (Shanghai's .SS), a Canadian unit (.UN) and a code another country writes (.IT) stay as typed.
test.each(["600519.SS", "REI.UN", "ENI.IT", "VOD.L", "0700.HK", "EUR/USD", "BTC/USD"])("%s is no near miss", (typed) => {
  expect(readNearMissListing(typed)).toBeNull();
});

test("the shared resolver reads a code before a company name search, and fn takes one with spaces", async () => {
  const searched: string[] = [];
  const listed: Record<string, InstrumentSearchResult[]> = {
    JPM: [{ providerId: "test", symbol: "JPM", name: "JPMorgan Chase & Co.", exchange: "NYSE", currency: "USD", type: "Common Stock" }],
    GLOBAL: [{ providerId: "test", symbol: "GLOBAL", name: "Global Holdings", exchange: "JSE", currency: "ZAR", type: "Common Stock" }],
  };
  const fund: InstrumentSearchResult = { providerId: "test", symbol: "PUEQX", name: "Putnam US Equity Fund", exchange: "NASDAQ", currency: "USD", type: "Mutual Fund" };
  const dataProvider = createTestDataProvider({
    search: async (query) => { searched.push(query); return listed[query] ?? (/putnam/i.test(query) ? [fund] : []); },
  });
  const deps = { store: { loadTicker: async () => null, loadAllTickers: async () => [] }, dataProvider };
  expect(await resolveCliListing("JPM US Equity", undefined, deps)).toMatchObject({ key: "JPM", request: { symbol: "JPM", exchange: "" } });
  expect(await resolveCliListing("jpm us equity", undefined, deps)).toMatchObject({ key: "JPM" });
  expect(await resolveCliListing("WFC.N", undefined, deps))
    .toMatchObject({ key: "WFC:NYSE", request: { symbol: "WFC:NYSE", exchange: "NYSE" }, readAs: "Read WFC.N as WFC:NYSE." });
  // A Reuters code costs no search; a Bloomberg code asks for its root, never for the words as a name.
  expect(searched).toEqual(["JPM", "JPM"]);
  // Words whose root is no US ticker are a fund's name, or fail as the words they are, never PUTNAM or GLOBAL.
  expect(await resolveCliListing("Putnam US Equity", undefined, deps))
    .toMatchObject({ key: "PUEQX:NASDAQ", readAs: 'Read "Putnam US Equity" as PUEQX:NASDAQ (Putnam US Equity Fund).' });
  const global = await resolveCliListing("Global US Equity", undefined, deps).then((listing) => listing.key, (error: Error) => error.message);
  expect(global).not.toBe("GLOBAL");
  expect(global).not.toContain("Read");

  const pane: PaneDef = { id: "sec", name: "SEC", component: () => null, defaultPosition: "right" };
  const headless: HeadlessPaneDefinition<"rows"> = { shape: "rows", argument: { kind: "ticker" }, options: [], load: () => ({ rows: [] }) };
  const template: PaneTemplateDef = {
    id: "sec-pane", paneId: "sec", label: "SEC", description: "SEC", shortcut: { prefix: "SEC", argPlaceholder: "", argKind: "ticker" }, headless,
  };
  const registry: PaneFunctionCatalog = { panes: new Map([["sec", pane]]), paneTemplates: new Map([["sec-pane", template]]), destroy: () => {} };
  const resolve = async (arg: string) => (await applyListingArgument(registry, deps as unknown as MarketContext, parsePaneFunctionArgs(["SEC", arg]))).arg;
  expect(await resolve("JPM US Equity")).toBe("JPM");
  expect(await resolve("WFC.N")).toBe("WFC:NYSE");
  // A ticker argument with spaces that is no code stays as typed, as before.
  expect(await resolve("Global US Equity")).toBe("Global US Equity");
});

test("a code abroad in capitals costs no search, one naming several listings is the first search lists, one in lower case is a code only where search lists it", async () => {
  const searched: string[] = [];
  const listed: Record<string, InstrumentSearchResult[]> = {
    // Search has Volvo's B shares as VOLV.B in Stockholm; VOLVB is a line in Prague.
    VOLVB: [
      { providerId: "test", symbol: "VOLVB", name: "Volvo AB (B)", exchange: "PSE", currency: "CZK", type: "Common Stock" },
      { providerId: "test", symbol: "VOLV.B", name: "Volvo AB", exchange: "SFB", currency: "SEK", type: "Common Stock" },
    ],
    VOD: [{ providerId: "test", symbol: "VOD", name: "Vodafone Group", exchange: "LSE", currency: "GBP", type: "Common Stock" }],
  };
  const dataProvider = createTestDataProvider({ search: async (query) => { searched.push(query); return listed[query] ?? []; } });
  const deps = { store: { loadTicker: async () => null, loadAllTickers: async () => [] }, dataProvider };
  expect(await resolveCliListing("MC FP", undefined, deps)).toMatchObject({ key: "MC:EPA", request: { symbol: "MC:EPA", exchange: "EPA" } });
  expect(searched).toEqual([]);
  expect(await resolveCliListing("VOLVB SS", undefined, deps)).toMatchObject({ key: "VOLV.B:SFB", readAs: 'Read "VOLVB SS" as VOLV.B:SFB.' });
  expect(await resolveCliListing("vod ln equity", undefined, deps)).toMatchObject({ key: "VOD:LSE" });
  // Words in lower case whose root search does not list there are words, never a listing in Amsterdam.
  const name = await resolveCliListing("Citibank NA Equity", undefined, deps).then((listing) => listing.key, (error: Error) => error.message);
  expect(name).not.toBe("CITIBANK:AMS");
});
