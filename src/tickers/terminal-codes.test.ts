import { expect, test } from "bun:test";
import { applyListingArgument } from "../cli/pane-functions/resolver";
import { parsePaneFunctionArgs } from "../cli/pane-functions/options";
import type { PaneFunctionCatalog } from "../cli/pane-functions/catalog";
import type { MarketContext } from "../cli/types";
import { ListingArgError, notTradedMessage, parseListingArg, resolveCliListing } from "../cli/listing-arg";
import { createTestDataProvider } from "../test-support/data-provider";
import type { InstrumentSearchResult } from "../types/instrument";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../types/plugin";
import { normalizeTickerInput } from "./search";
import { BLOOMBERG_MARKETS, endsInLegalForm, readNearMissListing, readTerminalListingCode, readVenueFirstListing, unknownBloombergMarket, unreadBloombergCode } from "./terminal-codes";
import { readNameEntries } from "../cli/name-entries";
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
  // A US share class reads as `BRK/B` does; abroad, as search lists it (BT.A).
  ["BRK/B US Equity", "BRK-B"],
  ["BRK/B UN Equity", "BRK-B:NYSE"],
  ["MC FP", "MC:EPA"],
  ["VOD LN Equity", "VOD:LSE"],
  ["vod ln equity", "VOD:LSE"],
  ["7203 JP", "7203:JPX"],
  ["CSL AU", "CSL:ASX"],
  // Hong Kong drops the leading zeros, the China composite is Shanghai for a 6 and Shenzhen otherwise.
  ["700 HK", "0700:HKEX"],
  ["600519 CH", "600519:SSE"],
  ["000001 CH Equity", "000001:SZSE"],
  // An SSE fund starts with 5.
  ["510300 CH", "510300:SSE"],
  // Venues search lists by a code the exchange table has no entry for yet.
  ["RYA ID", "RYA:ISE"],
  ["BBCA IJ", "BBCA:JAKARTA"],
  ["PTT TB", "PTT:SET"],
  ["1155 MK", "1155:BURSAMY"],
  // Borsa Istanbul, the Gulf, Cairo, Iceland and the CSE, whose venues the exchange table names.
  ["AKBNK TI", "AKBNK:BIST"],
  ["AKBNK TI Equity", "AKBNK:BIST"],
  ["2222 AB Equity", "2222:TADAWUL"],
  ["QNBK QD", "QNBK:QE"],
  ["NBB BI", "NBB:BHB"],
  ["EMAAR DB", "EMAAR:DFM"],
  ["OTEL OM", "OTEL:MSX"],
  ["NBK KK Equity", "NBK:KUWAIT"],
  ["COMI EY", "COMI:EGX"],
  ["ARION IR", "ARION:ICEX"],
  ["RWB CF", "RWB:CSE"],
  ["BT/A LN", "BT.A:LSE"],
  ["SPX Index", "^GSPC"],
  ["ES1 Index", "ES1E"],
  ["EURUSD Curncy", "EURUSD=X"],
  ["JPY Curncy", "USDJPY=X"],
  ["EUR Curncy", "EURUSD=X"],
  ["CL1 Comdty", "CL1E"],
  ["CO1 Comdty", "CO1E"],
  ["MOVE Index", "^MOVE"],
  ["DXY Curncy", "DX-Y.NYB"],
  ["JY1 Curncy", "6J1E"],
])("a terminal's code %s is the listing %s", (typed, key) => {
  expect(readTerminalListingCode(typed)?.key).toBe(key);
  expect(parseListingArg(typed).key).toBe(key);
  expect(normalizeTickerInput(null, typed)).toBe(key);
});

test.each(["VOD.L", "7203.T", "RY.TO", "0700.HK", "BRK.B", "BRK.A", "Wells Fargo", "AAPL MSFT", "vod ln", "Apple Co", "XYZ Index", "Gold Comdty", "USD Curncy", "CLZ6 Comdty", "P/E US", "N/A US Equity"])(
  "%s is not a terminal's code and parses as before",
  (typed) => {
    expect(readTerminalListingCode(typed)).toBeNull();
    expect(parseListingArg(typed).readAs).toBeUndefined();
  },
);

test("every market code reads as a venue of the shared exchange table, on its own and with the Equity key", () => {
  // Search lists these venues by these codes; the exchange table has no entry for them yet.
  const searchListed = new Set(["ISE", "JAKARTA", "SET", "BURSAMY"]);
  for (const [code, market] of Object.entries(BLOOMBERG_MARKETS)) {
    for (const venue of market.venues) expect(venue === "" || isKnownExchangeCode(venue) || searchListed.has(venue), `${code} ${venue}`).toBe(true);
    // A market no source quotes is a real code, refused by name.
    if (market.venues.length === 0) {
      expect(unknownBloombergMarket(`ABC ${code}`)?.unquoted, code).toBe(market.name);
      continue;
    }
    const read = readTerminalListingCode(`ABC ${code}`);
    expect(read?.market, code).toBe(code);
    expect(readTerminalListingCode(`ABC ${code} Equity`)?.key, code).toBe(read!.key);
    expect(read!.exchange, code).toBe(market.local === "china" ? "SZSE" : market.venues[0]);
    // A venue is written as `SYM:EXCH` names it, so a code and a typed key are one listing.
    expect(parseListingArg(read!.key).exchange, code).toBe(read!.exchange);
  }
  expect(Object.keys(BLOOMBERG_MARKETS)).toEqual(expect.arrayContaining([
    "LN", "GY", "GR", "FP", "SW", "NA", "IM", "SM", "SS", "DC", "NO", "FH", "JP", "JT", "HK", "KS", "CH", "TT", "AU", "IN", "CN",
    "ID", "IJ", "TB", "MK", "PM", "TI", "AB", "QD", "BI", "DB", "OM", "KK", "EY", "IR", "CF",
  ]));
});

// `AKBNK IS` reads as NSE, IS being Bloomberg's code for India; the refusal named neither the code nor the line to type.
test("a code whose venue does not list the symbol says which venue the code is and writes the symbol's own line the same way", async () => {
  const stock = (symbol: string, name: string, exchange: string): InstrumentSearchResult =>
    ({ providerId: "test", symbol, name, exchange, currency: "TRY", type: "Common Stock" });
  const listed: Record<string, InstrumentSearchResult[]> = {
    AKBNK: [stock("AKBNK", "Akbank T.A.S.", "BIST")],
    // Search finds Saudi Aramco by Bloomberg's ticker, under Tadawul's own code.
    ARAMCO: [stock("2222", "Saudi Arabian Oil Co.", "TADAWUL")],
  };
  const dataProvider = createTestDataProvider({
    search: async (query) => listed[query] ?? [],
    getQuote: async () => { throw new Error("Not a ticker"); },
  });
  const deps = { store: { loadTicker: async () => null, loadAllTickers: async () => [] }, dataProvider };
  const listing = await resolveCliListing("AKBNK IS", undefined, deps);
  expect(listing).toMatchObject({ key: "AKBNK:NSE", typed: "AKBNK IS" });
  expect(await notTradedMessage(listing, deps)).toBe("IS is Bloomberg's code for NSE, where AKBNK does not trade. Did you mean AKBNK TI (AKBNK:BIST)?");
  // Typed as a key, the venue is the reader's own choice: the plain answer.
  expect(await notTradedMessage({ symbol: "AKBNK", exchange: "NSE" }, deps)).toBe("AKBNK does not trade on NSE. AKBNK trades on: BIST.");
  const refusal = await resolveCliListing("ARAMCO AB", undefined, deps).then(() => null, (error: ListingArgError) => error);
  expect(refusal?.message).toBe("ARAMCO is not a TADAWUL code; did you mean 2222 AB (Saudi Arabian Oil Co.)?");
  expect(refusal?.details).toBe(BLOOMBERG_MARKETS.AB!.hint);
});

// A code on a market whose codes differ (MK, SP, AB) was refused as "not a ... code" when search listed nothing and the
// quote failed, which is what an unreachable quote source looks like too.
test("a code where Bloomberg's and the venue's codes differ is refused only on what search answered", async () => {
  const quotes: string[] = [];
  const unreachable = createTestDataProvider({
    search: async () => { throw Object.assign(new Error("Service unavailable"), { status: 503 }); },
    getQuote: async (symbol: string) => { quotes.push(symbol); throw new Error("fetch failed"); },
  });
  const silent = createTestDataProvider({
    search: async () => [],
    getQuote: async (symbol: string) => { quotes.push(symbol); throw new Error("fetch failed"); },
  });
  for (const dataProvider of [unreachable, silent]) {
    const deps = { store: { loadTicker: async () => null, loadAllTickers: async () => [] }, dataProvider };
    // The listing goes on to its own request, whose answer says what it finds.
    expect(await resolveCliListing("MAY MK", undefined, deps)).toMatchObject({ key: "MAY:BURSAMY" });
    expect(await resolveCliListing("ARAMCO AB", undefined, deps)).toMatchObject({ key: "ARAMCO:TADAWUL" });
  }
  // Nothing asked the quote to decide a refusal.
  expect(quotes).toEqual([]);
});

test("a code that names several listings lists the others to try after the first", () => {
  // Bloomberg glues a Nordic class on (VOLVB); ABB and NOKIA end in a letter too, so the code as written goes first.
  expect(readTerminalListingCode("VOLVB SS")).toMatchObject({ key: "VOLVB:SFB", alternatives: [{ key: "VOLV.B:SFB" }] });
  expect(readTerminalListingCode("ABB SS")?.key).toBe("ABB:SFB");
  // Canada's composite is Toronto, then the Venture exchange, then the CSE.
  expect(readTerminalListingCode("RY CN")).toMatchObject({ key: "RY:TSX", alternatives: [{ key: "RY:TSXV" }, { key: "RY:CSE" }] });
});

test("words written as a code with a market code no venue answers to are one refused entry; a name is not", () => {
  expect(unknownBloombergMarket("AAPL GP")).toEqual({ typed: "AAPL GP", symbol: "AAPL", market: "GP", keyed: false });
  expect(unknownBloombergMarket("KO PG")).toMatchObject({ symbol: "KO", market: "PG" });
  expect(unknownBloombergMarket("aapl zz equity")).toMatchObject({ symbol: "AAPL", market: "ZZ", keyed: true });
  for (const typed of ["Apple Co", "aapl gp", "VOD LN", "AAPL MSFT", "AAPL GP MSFT", "SPX Index", "P/E GP"]) expect(unknownBloombergMarket(typed), typed).toBeNull();
  // A list line, typed or a file's, is one entry: never AAPL and GP.
  expect(splitSymbolArgs(["AAPL GP"])).toEqual(["AAPL GP"]);
  expect(splitSymbolArgs(["MC FP"])).toEqual(["MC FP"]);
  expect(splitSymbolWords(["VOD LN", "AAPL MSFT"])).toEqual(["VOD LN", "AAPL", "MSFT"]);
  expect(parseSymbolText("MC FP\nAIR FP\nAAPL GP\n").symbols).toEqual(["MC FP", "AIR FP", "AAPL GP"]);
});

test.each([
  ["700.HK", "0700.HK"],
  // HKEXnews and the Product Key Facts print five digits.
  ["03042.HK", "3042.HK"],
  ["00700.HK", "0700.HK"],
  ["00700:HKEX", "0700:HKEX"],
  // Some data vendors write HKEX's suffix as .HKG.
  ["3042.HKG", "3042.HK"],
  ["700.HKG", "0700.HK"],
  ["6758.JP", "6758.T"],
  ["BRK/B", "BRK-B"],
  ["MC.FP", "MC.PA"],
])("%s, written nearly as a listing, reads as %s", (typed, symbol) => {
  expect(readNearMissListing(typed)?.symbol).toBe(symbol);
  expect(parseListingArg(typed)).toMatchObject({ key: symbol, readAs: `Read ${typed} as ${symbol}.` });
  expect(normalizeTickerInput(null, typed)).toBe(symbol);
});

// A listing suffix already (Shanghai's .SS), a Canadian unit (.UN) and a code another country writes (.IT) stay as typed.
// A slash after one letter is a ratio or an abbreviation, never a share class.
test.each(["600519.SS", "REI.UN", "ENI.IT", "VOD.L", "0700.HK", "83042.HK", "3042:HKEX", "0.HK", "00000.HK", "EUR/USD", "BTC/USD", "P/E", "N/A", "Y/Y", "q/q", "P/B"])("%s is no near miss", (typed) => {
  expect(readNearMissListing(typed)).toBeNull();
  expect(normalizeTickerInput(null, typed)).toBe(typed.toUpperCase());
});

test("two words ending in a company's legal form are a name to look up first, though SE is also SIX Swiss's code", () => {
  for (const typed of ["SAP SE", "SIEMENS AG", "Nestle SA", "ASML NV", "VOLVO AB", "BARCLAYS PLC"]) expect(endsInLegalForm(typed), typed).toBe(true);
  for (const typed of ["SAP SE Equity", "VOD LN", "NESN SW", "BANK OF AMERICA CORP"]) expect(endsInLegalForm(typed), typed).toBe(false);
  // Search sees the name, not SAP on SIX Swiss.
  expect(normalizeTickerInput(null, "SAP SE")).toBe("SAP SE");
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
  // A Reuters code costs no search, nor a US code in capitals with its yellow key; one in lower case asks for its
  // root, never for the words as a name.
  expect(searched).toEqual(["JPM"]);
  // Words whose root is no US ticker are a fund's name, or fail as the words they are, never PUTNAM or GLOBAL.
  expect(await resolveCliListing("Putnam US Equity", undefined, deps))
    .toMatchObject({ key: "PUEQX:NASDAQ", readAs: 'Read "Putnam US Equity" as PUEQX:NASDAQ (Putnam US Equity Fund).' });
  // All in capitals too: a fund's name in capitals is no code as typed.
  expect(await resolveCliListing("PUTNAM US EQUITY", undefined, deps)).toMatchObject({ key: "PUEQX:NASDAQ" });
  for (const typed of ["Global US Equity", "GLOBAL US EQUITY"]) {
    const global = await resolveCliListing(typed, undefined, deps).then((listing) => listing.key, (error: Error) => error.message);
    expect(global, typed).not.toBe("GLOBAL");
    expect(global, typed).not.toContain("Read");
  }

  const pane: PaneDef = { id: "sec", name: "SEC", component: () => null, defaultPosition: "right" };
  const headless: HeadlessPaneDefinition<"rows"> = { shape: "rows", argument: { kind: "ticker" }, options: [], load: () => ({ rows: [] }) };
  const template: PaneTemplateDef = {
    id: "sec-pane", paneId: "sec", label: "SEC", description: "SEC", shortcut: { prefix: "SEC", argPlaceholder: "", argKind: "ticker" }, headless,
  };
  const registry: PaneFunctionCatalog = { panes: new Map([["sec", pane]]), paneTemplates: new Map([["sec-pane", template]]), destroy: () => {} };
  const resolve = async (arg: string) => (await applyListingArgument(registry, deps as unknown as MarketContext, parsePaneFunctionArgs(["SEC", arg]))).arg;
  expect(await resolve("JPM US Equity")).toBe("JPM");
  expect(await resolve("WFC.N")).toBe("WFC:NYSE");
  // A ticker argument with spaces that is no code is no ticker: it stops before any report, as `quote` words it.
  await expect(resolve("Global US Equity")).rejects.toThrow("Not a ticker: GLOBAL US EQUITY.");
  // A line search no longer lists, written as Bloomberg writes it, is still that symbol: RAD, never a name.
  expect(await resolveCliListing("RAD US Equity", undefined, deps)).toMatchObject({ key: "RAD" });
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

test("two capitalised words are a company's name before a refusal, and a name before a legal form wins over the venue SE names", async () => {
  const stock = (symbol: string, name: string, exchange: string): InstrumentSearchResult =>
    ({ providerId: "test", symbol, name, exchange, currency: "EUR", type: "Common Stock" });
  const companies = [
    stock("SIE", "Siemens AG", "XETRA"), stock("NESN", "Nestlé S.A.", "SWX"), stock("ASML", "ASML Holding N.V.", "AMS"),
    stock("VOLV.B", "Volvo AB", "SFB"), stock("SAP", "SAP SE", "XETRA"),
  ];
  const searched: string[] = [];
  const dataProvider = createTestDataProvider({
    search: async (query) => {
      searched.push(query);
      const word = query.split(" ")[0]!.toUpperCase();
      const plain = (name: string) => name.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase();
      return companies.filter((company) => plain(company.name).startsWith(word) || company.symbol === word);
    },
  });
  const deps = { store: { loadTicker: async () => null, loadAllTickers: async () => [] }, dataProvider };
  const keyOf = (typed: string) => resolveCliListing(typed, undefined, deps).then((listing) => listing.key, (error: Error) => error.message);
  expect(await keyOf("SIEMENS AG")).toBe("SIE:XETRA");
  expect(await keyOf("NESTLE SA")).toBe("NESN:SWX");
  expect(await keyOf("ASML NV")).toBe("ASML:AMS");
  expect(await keyOf("VOLVO AB")).toBe("VOLV.B:SFB");
  // SE is SIX Swiss's market code too: the company SAP SE, not SAP on SIX Swiss.
  expect(await keyOf("SAP SE")).toBe("SAP:XETRA");
  // A code whose root names no company by these words is the code: NESN on SIX Swiss, Vodafone in London.
  expect(await keyOf("NESN SE")).toBe("NESN:SWX");
  searched.length = 0;
  expect(await keyOf("VOD LN")).toBe("VOD:LSE");
  expect(await keyOf("MC FP")).toBe("MC:EPA");
  expect(searched).toEqual([]);
  // Words that name no company are refused, never AAPL and GP; a market no source quotes says so.
  expect(await keyOf("AAPL GP")).toBe("GP is not a market code; did you mean AAPL?");
  expect(await keyOf("SM PM")).toBe("PM is the Philippine Stock Exchange, which has no quotes here.");
});

test("a code on a venue only search lists, or where Bloomberg's ticker is not the venue's, is checked there and says what to type", async () => {
  const listed: Record<string, InstrumentSearchResult[]> = {
    BBCA: [{ providerId: "test", symbol: "BBCA", name: "Bank Central Asia Tbk", exchange: "JAKARTA", currency: "IDR", type: "Common Stock" }],
    MAY: [{ providerId: "test", symbol: "MAY", name: "Mayfield", exchange: "ASX", currency: "AUD", type: "Common Stock" }],
  };
  const dataProvider = createTestDataProvider({ search: async (query) => listed[query] ?? [] });
  const deps = { store: { loadTicker: async () => null, loadAllTickers: async () => [] }, dataProvider };
  expect(await resolveCliListing("BBCA IJ", undefined, deps)).toMatchObject({ key: "BBCA:JAKARTA", readAs: 'Read "BBCA IJ" as BBCA:JAKARTA.' });
  const refused = await resolveCliListing("MAY MK", undefined, deps).then(() => null, (error: ListingArgError) => error);
  expect(refused?.message).toBe("MAY does not trade on BURSAMY. MAY trades on: ASX.");
  expect(refused?.details).toBe("Bloomberg and Bursa Malaysia codes differ there: type the Bursa code, such as 1155 MK for Maybank.");
});

// A spreadsheet writes the venue first; a symbol-first listing, a symbol that is a venue's code too, and a market id stay as typed.
test.each([
  ["TYO:7203", "7203:JPX"],
  ["LON:LSEG", "LSEG:LSE"],
  ["NASDAQ:AAPL", "AAPL:NASDAQ"],
  ["ETR:SAP", "SAP:XETRA"],
])("%s, written venue first, reads as %s", (typed, key) => {
  expect(readVenueFirstListing(typed)?.symbol).toBe(key);
  expect(parseListingArg(typed)).toMatchObject({ key, readAs: `Read ${typed} as ${key}.` });
});

// A ticker that is also a venue's code, before a two-letter market code, is written symbol first, as before.
test.each(["SAN:EPA", "BATS:LSE", "ICE:NYSE", "7203:JPX", "AAPL", "ICE:US", "CME:US", "NEO:US", "OTC:US", "ASX:AU", "BSE:IN", "AMS:SW"])("%s is not written venue first", (typed) => {
  expect(readVenueFirstListing(typed)).toBeNull();
});

test("a Bloomberg code nothing here reads is one entry, refused with what has it, never a name search or two symbols", async () => {
  // MOVE Index found another venue's product named after the index; GTJPY10Y Govt split into GTJPY10Y and the GOVT fund.
  const searched: string[] = [];
  const provider = createTestDataProvider({
    search: async (query: string) => {
      searched.push(query);
      return [{ symbol: "GOVT", name: "iShares U.S. Treasury Bond ETF", exchange: "ARCA", type: "ETF" } as InstrumentSearchResult];
    },
    getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: { symbol: target.symbol, price: 22 } as never })),
  });
  const entries = ["GTJPY10Y Govt", "USDJPY BGN Curncy", "XAU Curncy", "USGG2YR Index", "VXJ Index"];
  expect(entries.map((entry) => unreadBloombergCode(entry)?.yellowKey)).toEqual(["Govt", "Curncy", "Curncy", "Index", "Index"]);
  // Names that end in a key word, and codes the terminal reads, are not.
  for (const name of ["FTSE 100 Index", "Gold Comdty", "Nasdaq Index", "SPX Index", "JPY Curncy"]) expect(unreadBloombergCode(name), name).toBeNull();
  expect(await readNameEntries(entries, provider)).toEqual(entries);
  expect(searched).toEqual([]);
  const refusals = await Promise.all(entries.map((entry) => resolveCliListing(entry, undefined, { dataProvider: provider } as never)
    .then(() => null, (error: unknown) => error instanceof ListingArgError ? error.message : String(error))));
  expect(refusals).toEqual([
    "GTJPY10Y Govt is Bloomberg's code for a government bond, which is not quoted here. Japan's 10-year government yield: gloom fn G CAP:bond-yield:jp-10y.",
    "USDJPY BGN Curncy is not quoted here: Bloomberg's USD/JPY forwards, option volatilities, risk reversals and pricing sources are not carried. USD/JPY spot: gloom quote USDJPY=X.",
    "XAU Curncy: Spot gold is not quoted; GC=F is the front-month future.",
    "USGG2YR Index is Bloomberg's US 2-year Treasury yield, which has no quote here. Try `gloom fred DGS2` or `gloom yield-curve` for the US 2-year Treasury yield.",
    "VXJ Index is a Bloomberg index code no symbol here is read from. Try gloom search VXJ.",
  ]);
  expect(searched).toEqual([]);
});
