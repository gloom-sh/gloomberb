import { afterEach, beforeEach, expect, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import {
  joinCompanyNameWords, listCoinNotes, ListingArgError, listingChoiceNote, listingVenues, loadForListing, notTradedMessage, parseListingArg,
  readShareClassCode, resolveCliListing, usListingsOnlyMessage,
} from "./listing-arg";
import { LISTING_SEARCH_LIMIT } from "../tickers/search";
import { FUTURES_CONTRACTS } from "../market-data/futures-board";
import { resetBoardCoins } from "./board-coins";

const persistences: AppPersistence[] = [];

// A word read as a company's name checks the crypto board first: an empty board read, so no test asks the service.
beforeEach(() => resetBoardCoins([]));
afterEach(() => {
  for (const persistence of persistences.splice(0)) persistence.close();
  resetBoardCoins();
});

test("VX=F, written as CL=F is for a root VIX futures do not list it for, is the front generic VX1, and says so", () => {
  expect(parseListingArg("vx=f")).toEqual({ symbol: "VX1", exchange: "", key: "VX1", readAs: "Read VX=F as VX1, the front VIX future.", readFromName: true });
});

test("SYM:EXCH and --exchange name the same listing through the exchange aliases, and must agree", () => {
  for (const [raw, option] of [["san:xpar", undefined], ["SAN", "XPAR"], ["SAN:EPA", "epa"], ["SAN:", "EPA"], [" $San:Par ", "EPA"]] as const) {
    expect(parseListingArg(raw, option)).toEqual({ symbol: "SAN", exchange: "EPA", key: "SAN:EPA" });
  }
  expect(parseListingArg("aapl")).toEqual({ symbol: "AAPL", exchange: "", key: "AAPL" });
  // A coin pair as crypto venues write it is the coin's own symbol; a currency or metal pair is not a coin.
  expect(parseListingArg("btc/usd").key).toBe("BTC-USD");
  // A crypto exchange's line of a pair, as search offered it, is the crypto venue's listing: no source quotes the line.
  for (const [raw, option, key] of [["BTC/USD:BINANCE", undefined, "BTC-USD:CCC"], ["BTC/GBP:COINBASE PRO", undefined, "BTC-GBP:CCC"],
    ["eth/eur", "KRAKEN", "ETH-EUR:CCC"]] as const) {
    expect(parseListingArg(raw, option).key).toBe(key);
  }
  expect(parseListingArg("BRK/B:NYSE").key).toBe("BRK/B:NYSE");
  // Spot gold by the gram and crude keep their own listing (GAU-USD is a token), and a currency is its pair.
  for (const [raw, option, key] of [["GAU/USD:COMMODITY", undefined, "GAU/USD:COMMODITY"], ["WTI/USD", "COMMODITY", "WTI/USD:COMMODITY"],
    ["xbr/usd", undefined, "XBR/USD"], ["RUB/USD:CCY", undefined, "RUBUSD=X"]] as const) {
    expect(parseListingArg(raw, option).key, raw).toBe(key);
  }
  // A currency pair is the one listing the service has for it, on its venue by either name or by its syntax.
  for (const [raw, option] of [["EUR/USD", undefined], ["EURUSD:CCY", undefined], ["eurusd:fx", undefined], ["EURUSD", "FX"], ["EURUSD=X", "CCY"]] as const) {
    expect(parseListingArg(raw, option)).toEqual({ symbol: "EURUSD=X", exchange: "", key: "EURUSD=X" });
  }
  expect(parseListingArg("THB/USD").key).toBe("THBUSD=X");
  expect(parseListingArg("XAU/USD").key).toBe("XAU/USD");
  expect(() => parseListingArg("SAN:EPA", "LON")).toThrow("SAN:EPA names exchange EPA, but --exchange names LSE.");
  // With several symbols, --exchange only fills in the ones without their own.
  expect(parseListingArg("SAN:EPA", "LSE", { ownExchangeWins: true }).key).toBe("SAN:EPA");
});

test("a separator or quote marks left on a pasted ticker never reach the listing search, and a separator is named", () => {
  expect(parseListingArg("UPST;")).toEqual({ symbol: "UPST", exchange: "", key: "UPST", readAs: 'Ignored the stray ";" after UPST.' });
  expect(parseListingArg(`"san:epa",`)).toEqual({ symbol: "SAN", exchange: "EPA", key: "SAN:EPA", readAs: 'Ignored the stray "," after san:epa.' });
  // Quote marks alone say nothing; an exchange still has to agree with --exchange.
  expect(parseListingArg("'AAPL'")).toEqual({ symbol: "AAPL", exchange: "", key: "AAPL" });
  expect(() => parseListingArg("SAN:EPA;", "LON")).toThrow("SAN:EPA names exchange EPA, but --exchange names LSE.");
});

test("a futures board code no security uses is its future; one a security keeps, or one with a venue, stays as typed", () => {
  for (const row of FUTURES_CONTRACTS) {
    expect(parseListingArg(row.code).key).toBe(row.bareCode ? row.symbol : row.code);
    expect(parseListingArg(row.symbol.toLowerCase())).toEqual({ symbol: row.symbol, exchange: "", key: row.symbol });
  }
  expect(parseListingArg(" $ttf ")).toEqual({ symbol: "TTF=F", exchange: "", key: "TTF=F" });
  expect(parseListingArg("NG").key).toBe("NG");
  expect(parseListingArg("TTF", "LSE").key).toBe("TTF:LSE");
  // A contract as CTM prints it is its listing on the root's venue, CME crypto included; another root stays as typed.
  expect(parseListingArg("ETHX26")).toEqual({ symbol: "ETHX26.CME", exchange: "", key: "ETHX26.CME" });
  // CME's micro crypto contracts too, though they have no curve: MetLife stays MET.
  expect(["MBTX26", "metz26", "MSLX26", "MXPF27"].map((code) => parseListingArg(code).key))
    .toEqual(["MBTX26.CME", "METZ26.CME", "MSLX26.CME", "MXPF27.CME"]);
  expect(parseListingArg("MET").key).toBe("MET");
  expect(parseListingArg("clz26").key).toBe("CLZ26.NYM");
  expect(parseListingArg("ZNH27").key).toBe("ZNH27.CBT");
  expect(parseListingArg("ABCX26").key).toBe("ABCX26");
});

test("an exchange code the app does not know is refused unless the symbol trades there", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const row = { providerId: "test", symbol: "SAN", currency: "EUR", type: "Common Stock" };
  const dataProvider = createTestDataProvider({
    search: async () => [
      { ...row, name: "Banco Santander, S.A. Sponsored ADR", exchange: "NYSE", currency: "USD" },
      { ...row, name: "Sanofi SA", exchange: "EPA" },
      { ...row, name: "Banco Santander, S.A.", exchange: "BVL" },
    ],
  });
  const deps = { store, dataProvider };

  const refused = await resolveCliListing("SAN:ZZZ", undefined, deps).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ListingArgError);
  expect((refused as Error).message).toBe("Unknown exchange ZZZ for SAN. SAN trades on: NYSE, EPA, BVL.");
  // The currency venue is one the app knows, whatever search lists for the bare pair: it names the pair.
  expect((await resolveCliListing("EURUSD:FX", undefined, deps)).request).toEqual({ symbol: "EURUSD=X", exchange: "" });
  // A venue only search knows is still the symbol's own listing; data requests go by its key.
  expect((await resolveCliListing("SAN", "BVL", deps)).request).toEqual({ symbol: "SAN:BVL", exchange: "BVL" });

  // Sanofi in Paris saved under the bare key: the bare symbol is still its US listing, read as with nothing saved.
  await store.createTicker({
    ticker: "SAN", exchange: "EPA", currency: "EUR", name: "Sanofi", portfolios: [], watchlists: [], positions: [], custom: {}, tags: [],
  });
  const bare = await resolveCliListing("SAN", undefined, deps);
  expect(bare.saved).toBeNull();
  expect(bare.request).toEqual({ symbol: "SAN", exchange: "" });
  expect((await resolveCliListing("SAN:XPAR", undefined, deps)).saved?.metadata.name).toBe("Sanofi");
  expect((await resolveCliListing("SAN:NYSE", undefined, deps)).saved).toBeNull();
});

test("BRK B and BRKB are Berkshire's class B, the saved row first, never the ETN named for it, naming the code's lines abroad", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const row = { providerId: "test", currency: "USD", type: "Common Stock" };
  const berkshire = { ...row, name: "Berkshire Hathaway Inc. Class B" };
  const dataProvider = createTestDataProvider({
    search: async (query) => {
      const asked = query.replace(/:$/, "").toUpperCase();
      if (asked === "BRK.B") return [{ ...berkshire, symbol: "BRK.B", exchange: "IEX" }, { ...berkshire, symbol: "BRK.B", exchange: "NYSE" }];
      if (asked === "BRKB") return [{ ...berkshire, symbol: "BRKB", exchange: "BMV", currency: "MXN" }, { ...berkshire, symbol: "BRKB", exchange: "WSE", currency: "PLN" }];
      // HEIA is Heineken's code in Amsterdam, whatever HEICO's class A is.
      if (asked === "HEIA") return [{ ...row, symbol: "HEIA", name: "Heineken N.V.", exchange: "AMS", currency: "EUR" }];
      // What the words "BRK B" find as a name: the fund whose name carries BRK/B.
      return [{ ...row, symbol: "^BRKU", name: "Direxion Daily BRK/B Bull 2X Shares", exchange: "NIM", type: "ETN" }];
    },
  });
  const deps = { store, dataProvider };

  // Nothing saved: the spaced class is the US listing search lists, NYSE before IEX; the joined code is left to `quote`.
  const spaced = await resolveCliListing("BRK B", undefined, deps);
  expect(spaced.request).toEqual({ symbol: "BRK.B", exchange: "" });
  expect(spaced.readAs).toBe('Read "BRK B" as BRK.B (Berkshire Hathaway Inc. Class B); also BRKB:BMV, BRKB:WSE.');
  expect((await resolveCliListing("BRKB", undefined, deps)).request).toEqual({ symbol: "BRKB", exchange: "" });
  expect((await readShareClassCode("BRKB", deps, { unsaved: true }))?.key).toBe("BRK.B");

  // The held row reads both spellings, under the spelling it was saved as.
  await store.createTicker({
    ticker: "BRK-B", exchange: "NYSE", currency: "USD", name: "Berkshire Hathaway Inc.", portfolios: [], watchlists: [], positions: [], custom: {}, tags: [],
  });
  for (const typed of ["BRK B", "brk b", "BRKB"]) {
    const listing = await resolveCliListing(typed, undefined, deps);
    expect(listing.saved?.metadata.ticker, typed).toBe("BRK-B");
    expect(listing.readAs, typed).toBe(`Read "${typed}" as BRK-B (Berkshire Hathaway Inc.); also BRKB:BMV, BRKB:WSE.`);
  }
  // A code of another company abroad stays that company's, and a plain ticker never reads as a class.
  await store.createTicker({
    ticker: "HEI.A", exchange: "NYSE", currency: "USD", name: "HEICO Corporation", portfolios: [], watchlists: [], positions: [], custom: {}, tags: [],
  });
  expect(await readShareClassCode("HEIA", deps, { unsaved: true })).toBeNull();
  expect(await readShareClassCode("AAPL", deps, { unsaved: true })).toBeNull();
});

test("a Hong Kong code without its leading zeros is its HKEX listing where search marks it, unless a row is saved under it", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const row = { providerId: "test", type: "Common Stock" };
  const dataProvider = createTestDataProvider({
    search: async (query) => query === "700" ? [
      { ...row, symbol: "0700", name: "Tencent Holdings Limited", exchange: "HKEX", currency: "HKD", searchAliases: ["0700", "700"] },
      { ...row, symbol: "700", name: "Certara Inc.", exchange: "XHAM", currency: "EUR" },
    ] : [{ ...row, symbol: query, name: "Hamburg line", exchange: "XHAM", currency: "EUR" }],
  });
  const deps = { store, dataProvider };
  // Search lists the Hamburg line under the code as typed, but marks Tencent with it: Hong Kong writes 0700 as 700.
  const tencent = await resolveCliListing("700", undefined, deps);
  expect(tencent).toMatchObject({ key: "0700:HKEX", readAs: "Read 700 as 0700:HKEX." });
  expect(tencent.request).toEqual({ symbol: "0700:HKEX", exchange: "HKEX" });
  // A code search marks no HKEX listing with stays as typed.
  expect((await resolveCliListing("701", undefined, deps)).key).toBe("701");
  await store.createTicker({
    ticker: "700", exchange: "XHAM", currency: "EUR", name: "Certara Inc.", portfolios: [], watchlists: [], positions: [], custom: {}, tags: [],
  });
  expect((await resolveCliListing("700", undefined, deps)).key).toBe("700");
});

test("FRED:T10Y2Y is the series the catalog prints, never FRED on an exchange called T10Y2Y; FRED on a known venue is a listing", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const searched: string[] = [];
  const dataProvider = createTestDataProvider({
    search: async (query) => {
      searched.push(query);
      return [{ providerId: "test", symbol: "FRED", name: "Fredonia Mining Inc.", exchange: "TSXV", type: "Common Stock", currency: "CAD" }];
    },
  });
  const deps = { store: new TickerRepository(persistence.tickers), dataProvider };
  const refused = await resolveCliListing("FRED:T10Y2Y", undefined, deps).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ListingArgError);
  expect((refused as ListingArgError).message).toBe("FRED:T10Y2Y is a FRED series, not a listing.");
  expect((refused as ListingArgError).details).toBe("Chart it with gloom fn G FRED:T10Y2Y, or read it with gloom fred T10Y2Y.");
  // Said before any lookup, and the same however it is cased.
  expect(searched).toEqual([]);
  expect(((await resolveCliListing("fred:dgs10", undefined, deps).catch((error: unknown) => error)) as Error).message).toBe("FRED:DGS10 is a FRED series, not a listing.");
  expect((await resolveCliListing("FRED:TSXV", undefined, deps)).request).toEqual({ symbol: "FRED:TSXV", exchange: "TSXV" });
});

test("an index typed with the venue search files it under resolves as the bare symbol does", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const dataProvider = createTestDataProvider({
    search: async () => [{ providerId: "test", symbol: "^VIX", name: "CBOE Volatility Index", exchange: "CXI", type: "INDEX", currency: "USD" }],
  });
  const deps = { store, dataProvider };
  // CXI is no exchange code the app has a name for: it is the venue, and the only one, search lists for ^VIX.
  expect(await resolveCliListing("^VIX:CXI", undefined, deps)).toMatchObject({ symbol: "^VIX", exchange: "CXI", request: { symbol: "^VIX:CXI", exchange: "CXI" } });
  expect((await resolveCliListing("^VIX", "CXI", deps)).key).toBe("^VIX:CXI");
  // Another code is still a typo, and says where the index is listed.
  const refused = await resolveCliListing("^VIX:ZZZ", undefined, deps).catch((error: unknown) => error);
  expect((refused as Error).message).toBe("Unknown exchange ZZZ for ^VIX. ^VIX trades on: CXI.");
});

test("a broker's index code is the index, and a cashtag stays the stock it names", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const quoted: string[] = [];
  // No source lists VIX; MOVE is Corvex, AAPL Apple, and a quote for MID times out.
  const dataProvider = createTestDataProvider({
    getQuote: async (symbol) => {
      quoted.push(symbol);
      if (symbol === "VIX") throw new Error("No provider available for VIX");
      if (symbol === "MID") throw new Error("Request timed out after 10000ms");
      return createTestQuote({ symbol, instrumentType: "EQUITY" });
    },
  });
  const deps = { store, dataProvider };
  // thinkorswim's VIX.X and $VIX.X are only ever the index, so they are read without a request.
  for (const typed of ["VIX.X", "$vix.x", "SPX.X"]) expect(parseListingArg(typed).key).toBe(typed.toUpperCase().includes("SPX") ? "^SPX" : "^VIX");
  expect(parseListingArg("VIX.X").readAs).toBe("Read VIX.X as ^VIX (Cboe Volatility Index).");
  expect(quoted).toEqual([]);
  // Schwab's $VIX is the index because VIX quotes nothing; $MOVE and $AAPL are the securities that trade as MOVE and AAPL.
  expect(await resolveCliListing("$VIX", undefined, deps)).toMatchObject({ key: "^VIX", request: { symbol: "^VIX" } });
  expect((await resolveCliListing("$MOVE", undefined, deps)).key).toBe("MOVE");
  expect(await resolveCliListing("$AAPL", undefined, deps)).toMatchObject({ key: "AAPL", request: { symbol: "AAPL" } });
  expect((await resolveCliListing("$AAPL", undefined, deps)).readAs).toBeUndefined();
  // A timeout says nothing about what trades as MID, so $MID stays the symbol typed rather than the index.
  expect((await resolveCliListing("$MID", undefined, deps)).key).toBe("MID");
  // A root no index is known by is never looked up as one, and a named exchange keeps the symbol as typed.
  expect(quoted).toEqual(["VIX", "MOVE", "MID"]);
  expect(parseListingArg("VIX.X", "NYSE").key).toBe("VIX.X:NYSE");
});

test("a bare index root no security trades as is its index for every command, saying so; one a security trades as stays it", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  // `history NDX` was a stopped Frankfurt line's bars: nothing quotes NDX, and the service marks ^NDX:NIM for the word.
  const dataProvider = createTestDataProvider({
    getQuote: async (symbol) => {
      if (symbol === "NDX" || symbol === "VIX" || symbol === "VHSI") throw new Error(`Not a ticker: ${symbol}.`);
      return createTestQuote({ symbol, name: symbol === "MOVE" ? "Corvex, Inc." : symbol, instrumentType: "EQUITY" });
    },
    search: async (query) => query.replace(/^\^/, "") === "NDX"
      ? [{ providerId: "test", symbol: "^NDX", name: "NASDAQ-100", exchange: "NIM", type: "INDEX", searchAliases: ["NDX"] }]
      : [],
  });
  const deps = { store, dataProvider };
  expect(await resolveCliListing("NDX", undefined, deps))
    .toMatchObject({ key: "^NDX:NIM", request: { symbol: "^NDX:NIM", exchange: "NIM" }, readAs: 'Read "NDX" as ^NDX:NIM (NASDAQ-100).' });
  // No listing marked for the word: the ^ symbol, named by the index it roots.
  expect(await resolveCliListing("vix", undefined, deps)).toMatchObject({ key: "^VIX", readAs: 'Read "vix" as ^VIX (Cboe Volatility Index).' });
  // VHSI, the HSI Volatility Index, is listed as ^HSIL, not ^VHSI.
  expect(await resolveCliListing("VHSI", undefined, deps)).toMatchObject({ key: "^HSIL", readAs: 'Read "VHSI" as ^HSIL (HSI Volatility Index).' });
  // MOVE is Corvex, which `quote MOVE` gives too; a row saved under NDX is that row's.
  const move = await resolveCliListing("MOVE", undefined, deps);
  expect([move.key, move.readAs]).toEqual(["MOVE", undefined]);
  await store.createTicker({ ticker: "NDX", exchange: "", currency: "EUR", name: "Nordex SE", portfolios: [], watchlists: [], positions: [], custom: {}, tags: [] });
  expect((await resolveCliListing("NDX", undefined, deps)).key).not.toBe("^NDX:NIM");
});

test("a perpetual is a listing on its venue, typed by PERP's market id or Hyperliquid's dex name", async () => {
  expect(parseListingArg("binance:BZUSDT")).toEqual({ symbol: "BZUSDT", exchange: "BINANCE", key: "BZUSDT:BINANCE" });
  expect(parseListingArg("hyperliquid:xyz:BRENTOIL").key).toBe("XYZ-BRENTOIL:HYPERLIQUID");
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const searched: string[] = [];
  const dataProvider = createTestDataProvider({
    search: async (query) => {
      searched.push(query);
      return query === "XYZ-BRENTOIL:HYPERLIQUID"
        ? [{ providerId: "test", symbol: "XYZ-BRENTOIL:HYPERLIQUID", name: "Brent crude oil perpetual", exchange: "HYPERLIQUID", type: "PERP" }]
        : [];
    },
  });
  // Upper-cased on the command line, xyz:BRENTOIL reads as a symbol on an exchange no venue has: it is the dex market.
  expect((await resolveCliListing("XYZ:BRENTOIL", undefined, { store, dataProvider })).request)
    .toEqual({ symbol: "XYZ-BRENTOIL:HYPERLIQUID", exchange: "HYPERLIQUID" });
  // A mistyped exchange with no such market still says the exchange is unknown.
  const refused = await resolveCliListing("XOM:NYSEE", undefined, { store, dataProvider }).catch((error: unknown) => error);
  expect((refused as Error).message).toStartWith("Unknown exchange NYSEE for XOM.");
  expect(searched).toContain("XOM-NYSEE:HYPERLIQUID");
});

test("a request for an exchange the symbol is not listed on ends in where it trades, and only a miss looks the venues up", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const row = { providerId: "test", symbol: "SAN", currency: "EUR", type: "Common Stock" };
  let searches = 0;
  const dataProvider = createTestDataProvider({
    search: async () => {
      searches += 1;
      return [{ ...row, name: "Banco Santander", exchange: "NYSE" }, { ...row, name: "Sanofi SA", exchange: "EPA" }];
    },
  });
  const deps = { store, dataProvider };
  const ctx = { fail: (message: string): never => { throw new ListingArgError(message); } };
  const listing = (raw: string) => resolveCliListing(raw, undefined, deps);
  const failed = new Error("No provider available for SAN:TSX");

  // TSX is a code the app knows, so the exchange check lets it through; the data request is what comes back empty.
  const tsx = await listing("SAN:TSX");
  searches = 0;
  expect(await loadForListing(tsx, deps, ctx, async () => ["bar"], (bars) => bars.length === 0)).toEqual(["bar"]);
  expect(searches).toBe(0);

  const message = "SAN does not trade on TSX. SAN trades on: NYSE, EPA.";
  await expect(loadForListing(tsx, deps, ctx, async () => { throw failed; })).rejects.toThrow(message);
  await expect(loadForListing(tsx, deps, ctx, async () => [], (bars) => bars.length === 0)).rejects.toThrow(message);

  // A listed venue keeps the request's own failure, and a bare symbol names no venue to check.
  await expect(loadForListing(await listing("SAN:EPA"), deps, ctx, async () => { throw failed; })).rejects.toBe(failed);
  searches = 0;
  await expect(loadForListing(await listing("SAN"), deps, ctx, async () => { throw failed; })).rejects.toBe(failed);
  expect(searches).toBe(0);
});

test("a bare code several companies list asks which, whichever way the router words it, and never says one of them has no data", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const row = { providerId: "test", symbol: "2222", currency: "SAR", type: "Common Stock" };
  const dataProvider = createTestDataProvider({
    search: async () => [{ ...row, name: "Kotobuki Spirits Co., Ltd.", exchange: "JPX" }, { ...row, name: "Saudi Arabian Oil Co.", exchange: "TADAWUL" }],
  });
  const deps = { store, dataProvider };
  const ctx = { fail: (message: string, details?: string): never => { throw new ListingArgError(message, details); } };
  const request = { command: "history", noun: "history" };
  const bare = await resolveCliListing("2222", undefined, deps);
  for (const wording of ["No history provider available for 2222", "Not a ticker: 2222."]) {
    const failure = await loadForListing(bare, deps, ctx, async () => { throw new Error(wording); }, undefined, request).catch((error) => error);
    expect(failure).toBeInstanceOf(ListingArgError);
    expect(failure.message).toBe("Choose an exchange for 2222.");
    // Every venue is a choice, the first included.
    expect(failure.details).toBe([
      "Listings:",
      "  2222:JPX Kotobuki Spirits Co., Ltd. (try: gloom history 2222:JPX)",
      "  2222:TADAWUL Saudi Arabian Oil Co. (try: gloom history 2222:TADAWUL)",
    ].join("\n"));
  }
  // A timeout is not a missing listing: it surfaces as it was thrown.
  const timeout = new Error("request timed out");
  await expect(loadForListing(bare, deps, ctx, async () => { throw timeout; }, undefined, request)).rejects.toBe(timeout);

  // A symbol saved on a venue keeps going there: that venue is the one without data, the other its alternative.
  await store.createTicker({
    ticker: "2222", exchange: "TADAWUL", currency: "SAR", name: "Saudi Aramco", portfolios: [], watchlists: [], positions: [], custom: {}, tags: [],
  });
  const saved = await loadForListing(await resolveCliListing("2222", undefined, deps), deps, ctx, async () => { throw new Error("Not a ticker: 2222."); }, undefined, request)
    .catch((error) => error);
  expect(saved.message).toBe("2222 resolved to Saudi Arabian Oil Co. (TADAWUL), which has no history.");
  expect(saved.details).toBe("Other listings: 2222:JPX Kotobuki Spirits Co., Ltd. (try: gloom history 2222:JPX)");
});

test("a venue naming its line by the code alone is no other company: bare ITBEES goes to NSE's fund, never asks", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const row = { providerId: "test", symbol: "ITBEES", currency: "INR" };
  const dataProvider = createTestDataProvider({
    search: async () => [{ ...row, name: "Nippon India ETF Nifty IT", exchange: "NSE", type: "ETF" }, { ...row, name: "ITBEES", exchange: "BSE", type: "Common Stock" }],
  });
  const deps = { store, dataProvider };
  const ctx = { fail: (message: string, details?: string): never => { throw new ListingArgError(message, details); } };
  const failure = await loadForListing(await resolveCliListing("ITBEES", undefined, deps), deps, ctx,
    async () => { throw new Error("No history provider available for ITBEES"); }, undefined, { command: "history", noun: "history" }).catch((error) => error);
  expect(failure.message).toBe("ITBEES resolved to Nippon India ETF Nifty IT (NSE), which has no history.");
  expect(failure.details).toBe("Other listings: ITBEES:BSE ITBEES (try: gloom history ITBEES:BSE)");
});

test("a bare Indian code goes to the venue with a real name, NSE before BSE, whichever search lists first", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const ctx = { fail: (message: string, details?: string): never => { throw new ListingArgError(message, details); } };
  const resolved = async (symbol: string, rows: { name: string; exchange: string }[]) => {
    const deps = { store, dataProvider: createTestDataProvider({ search: async () => rows.map((row) => ({ providerId: "test", symbol, currency: "INR", ...row })) }) };
    const failure = await loadForListing(await resolveCliListing(symbol, undefined, deps), deps, ctx,
      async () => { throw new Error(`No history provider available for ${symbol}`); }, undefined, { command: "history", noun: "history" }).catch((error) => error);
    return failure.message;
  };
  // Search lists BSE's code-only line first: the NSE fund is the one meant.
  expect(await resolved("ITBEES", [{ name: "ITBEES", exchange: "BSE" }, { name: "Nippon India ETF Nifty IT", exchange: "NSE" }]))
    .toBe("ITBEES resolved to Nippon India ETF Nifty IT (NSE), which has no history.");
  // Both named, BSE first: NSE still comes first.
  expect(await resolved("INFY", [{ name: "Infosys Limited", exchange: "BSE" }, { name: "Infosys Limited", exchange: "NSE" }]))
    .toBe("INFY resolved to Infosys Limited (NSE), which has no history.");
});

test("listings of one company, however each venue spells its name, still go to the first venue with the others as retries", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const row = { providerId: "test", symbol: "SAN", currency: "EUR", type: "Common Stock" };
  const dataProvider = createTestDataProvider({
    search: async () => [
      { ...row, name: "Banco Santander, S.A.", exchange: "NYSE" },
      { ...row, name: "BANCO SANTANDER SA Sponsored ADR", exchange: "BVL" },
      // A venue that names no company is not another one.
      { ...row, name: "", exchange: "XETRA" },
    ],
  });
  const deps = { store, dataProvider };
  const ctx = { fail: (message: string, details?: string): never => { throw new ListingArgError(message, details); } };
  const failure = await loadForListing(
    await resolveCliListing("SAN", undefined, deps), deps, ctx, async () => { throw new Error("No history provider available for SAN"); },
    undefined, { command: "history --range 5Y", noun: "history" },
  ).catch((error) => error);
  expect(failure.message).toBe("SAN resolved to Banco Santander, S.A. (NYSE), which has no history.");
  expect(failure.details).toContain("SAN:BVL BANCO SANTANDER SA Sponsored ADR (try: gloom history SAN:BVL --range 5Y)");
  expect(failure.details).toContain("SAN:XETRA (try: gloom history SAN:XETRA --range 5Y)");
});

// As search listed them on 2026-10-27. One fund's venues word its name differently; other companies use the symbol abroad.
test("the line naming a bare symbol's listing names only other companies' venues, never the same fund's or a receipt it cannot place", () => {
  const ewg = [
    { exchange: "ARCA", name: "iShares MSCI Germany Index Fund" },
    { exchange: "BMV", name: "iShares MSCI Germany ETF" },
    { exchange: "CSE", name: "Eat Well Investment Group Inc." },
    { exchange: "LSE", name: "W.A.G Payment Solutions plc" },
  ];
  expect(listingChoiceNote("EWG", { exchange: "ARCA", name: "iShares MSCI Germany Index Fund" }, ewg))
    .toBe("EWG = iShares MSCI Germany Index Fund, NYSE Arca (different companies on the Canadian Securities Exchange, the London Stock Exchange)");
  // Another issuer's fund under the symbol is another company's.
  expect(listingChoiceNote("INDA", { exchange: "BATS", name: "iShares MSCI India ETF" }, [
    { exchange: "BATS", name: "iShares MSCI India ETF" },
    { exchange: "XETRA", name: "Amundi STOXX Europe 600 Banks UCITS ETF Acc" },
  ])).toBe("INDA = iShares MSCI India ETF, Cboe BZX (a different company on Xetra)");
  // A US fund's receipt in Buenos Aires is the fund, however it is named, so a symbol that means one thing says nothing.
  const xlk = { exchange: "ARCA", name: "State Street Technology Select Sector SPDR ETF" };
  expect(listingChoiceNote("XLK", xlk, [xlk, { exchange: "BYMA", name: "Technology Select Sector SPDR Fund" }])).toBeNull();
  const spy = { exchange: "ARCA", name: "State Street SPDR S&P 500 ETF Trust" };
  expect(listingChoiceNote("SPY", spy, [spy, { exchange: "BYMA", name: "SS SPDR S&P 500 ETF Trust - CEDEAR" }])).toBeNull();
  // A listing nothing names is not guessed to be another company's, nor is the one the symbol was read as.
  expect(listingChoiceNote("EWG", { exchange: "ARCA" }, [{ exchange: "ARCA", name: "" }, ...ewg.slice(2)])).toBeNull();
  expect(listingChoiceNote("EWG", { exchange: "ARCA", name: "iShares MSCI Germany Index Fund" }, [...ewg.slice(0, 2), { exchange: "CSE", name: "" }]))
    .toBeNull();
});

// CAR as search listed it on 2026-10-11 in its first rows: Avis and Carrefour, but not CAR Group's ASX line.
const CAR_ROWS = [
  { providerId: "test", symbol: "CAR", name: "Carrefour SA", exchange: "XETRA", currency: "EUR", type: "Common Stock" },
  { providerId: "test", symbol: "CAR", name: "Avis Budget Group Inc.", exchange: "NASDAQ", currency: "USD", type: "Common Stock" },
  { providerId: "test", symbol: "CAR", name: "Avis Budget Group, Inc. CEDEAR", exchange: "BYMA", currency: "ARS", type: "Depositary Receipt" },
];

test("every command agrees with quote on where a symbol trades: a venue search leaves out trades it when its quote prices it there", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const limits: Array<number | undefined> = [];
  const dataProvider = createTestDataProvider({
    search: async (_query, context) => {
      limits.push(context?.limit);
      return CAR_ROWS;
    },
    // The listing's own quote, as `quote CAR:ASX` reads it.
    getQuote: async (symbol, exchange) => {
      if (symbol !== "CAR:ASX") throw new Error(`No quote for ${symbol}`);
      return { symbol: "CAR.AX", name: "CAR Group Limited", price: 22.8, currency: "AUD", change: 0, changePercent: 0, lastUpdated: 1, listingExchangeName: exchange };
    },
  });
  const deps = { store, dataProvider };
  const ctx = { fail: (message: string): never => { throw new ListingArgError(message); } };

  // An empty answer (CAR Group files nothing with the SEC) is not a venue CAR is missing from.
  const asx = await resolveCliListing("CAR", "ASX", deps);
  expect(await loadForListing(asx, deps, ctx, async () => [], (rows) => rows.length === 0)).toEqual([]);
  expect(await notTradedMessage(asx, deps)).toBeNull();
  // The venue list asks for every company's rows, not a keystroke's ten.
  expect(limits.every((limit) => limit === LISTING_SEARCH_LIMIT)).toBe(true);
  // Neither search nor a quote places CAR on TSX.
  expect(await notTradedMessage(await resolveCliListing("CAR:TSX", undefined, deps), deps))
    .toBe("CAR does not trade on TSX. CAR trades on: XETRA, NASDAQ, BYMA.");

  // The one line naming which company a bare CAR went to, and the companies it did not.
  const venues = await listingVenues("CAR", deps);
  expect(listingChoiceNote("CAR", { exchange: "NASDAQ", name: "Avis Budget Group, Inc." }, [...venues, { exchange: "ASX", name: "CAR Group Limited" }]))
    .toBe("CAR = Avis Budget Group, NASDAQ (different companies on Xetra, the Australian Securities Exchange)");
  expect(listingChoiceNote("CAR", { exchange: "NASDAQ", name: "Avis Budget Group, Inc." }, venues.filter((venue) => venue.exchange !== "XETRA")))
    .toBeNull();
});

test("a list's bare coin code read as a listing says so, as quote does: CORR RIOT,BTC names BTC-USD; RIOT and a named listing are not asked", async () => {
  const asked: string[] = [];
  const dataProvider = createTestDataProvider({
    getQuote: async (symbol: string) => {
      asked.push(symbol);
      return createTestQuote({ symbol, name: "Grayscale Bitcoin Mini Trust ETF", instrumentType: "ETF" });
    },
  });
  const listing = (symbol: string, exchange = "") => ({ symbol, exchange, request: { symbol: exchange ? `${symbol}:${exchange}` : symbol, exchange } });
  expect(await listCoinNotes([listing("RIOT"), listing("BTC"), listing("ETH", "ARCA")], { dataProvider }))
    .toEqual(["BTC is Grayscale Bitcoin Mini Trust ETF, not bitcoin. For bitcoin use BTC-USD."]);
  expect(asked).toEqual(["BTC"]);
});

test("a US-only alert on a suffixed listing abroad names its venue from the quote, and a currency pair says it is one", async () => {
  // Before: "Toyota Motor on ." and "GBP/USD on .", as a vendor suffix names no venue until the quote does.
  const dataProvider = createTestDataProvider({
    getQuote: async (symbol) => symbol === "GBPUSD=X"
      ? createTestQuote({ symbol, name: "GBP/USD", exchange: "CCY", currency: "USD" })
      : createTestQuote({ symbol, name: "Toyota Motor Corporation", exchange: "JPX", listingExchangeName: "JPX", currency: "JPY" }),
    search: async (query) => /toyota/i.test(query)
      ? [{ providerId: "test", symbol: "TM", name: "Toyota Motor Corporation", exchange: "NYSE", currency: "USD", type: "Common Stock" }]
      : [],
  });
  const listing = (symbol: string) => ({ symbol, exchange: "", key: symbol, request: { symbol, exchange: "" }, saved: null });
  const deps = { dataProvider, store: { loadTicker: async () => null, loadAllTickers: async () => [] } };
  const what = "Unusual volume alerting";
  const toyota = await usListingsOnlyMessage(what, listing("7203.T"), deps, (key) => `gloom alerts add ${key} unusual volume 3x`);
  expect(toyota.message).toBe("Unusual volume alerting covers US listings only, and 7203.T is Toyota Motor on Tokyo Stock Exchange (JPX).");
  expect(toyota.details).toBe("Toyota Motor's US listing: TM (try: gloom alerts add TM unusual volume 3x)");
  expect(await usListingsOnlyMessage(what, listing("GBPUSD=X"), deps, () => null)).toEqual({
    message: "Unusual volume alerting covers US listings only, and GBPUSD=X is a currency pair.",
    details: "A currency pair trades over the counter, with no exchange volume to follow.",
  });
});

test("a listing that moved to a new symbol, typed by its old symbol or its old name, is the one it trades as now", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const deps = { store: new TickerRepository(persistence.tickers), dataProvider: createTestDataProvider({ search: async () => [] }) };
  for (const typed of ["ELET3.SA", "ELET3", "eletrobras", "Centrais Eletricas Brasileiras"]) {
    const listing = await resolveCliListing(typed, undefined, deps);
    expect(listing.request.symbol, typed).toBe("AXIA3.SA");
    const shown = /^ELET/.test(typed) ? typed : `"${typed}"`;
    expect(listing.readAs, typed).toStartWith(`Read ${shown} as AXIA3.SA: Eletrobras is AXIA Energia now.`);
  }
  // The preferred lines took AXIA6 and AXIA5, then were converted into the common shares on 5 Jun 2026.
  for (const typed of ["ELET6", "ELET5.SA", "AXIA6", "AXIA5.SA"]) {
    const listing = await resolveCliListing(typed, undefined, deps);
    expect(listing.request.symbol, typed).toBe("AXIA3.SA");
    expect(listing.readAs, typed).toStartWith(
      `Read ${typed} as AXIA3.SA: those preferred shares were converted into AXIA Energia's common shares on 5 Jun 2026.`);
  }
  // Named on a venue, the old symbol is what was asked for.
  expect((await resolveCliListing("ELET3", "B3", deps)).request.symbol).not.toBe("AXIA3.SA");
});

test("a code its exchange withdrew is that company, gone on its day for its reason, never the line another market trades under the digits", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  // 0011 as search answers it once HKEX withdrew Hang Seng Bank: Bursa's Brite-Tech still trades under the digits.
  const dataProvider = createTestDataProvider({
    search: async () => [
      { providerId: "test", symbol: "0011", name: "Brite-Tech Berhad", exchange: "BURSAMY", currency: "MYR", type: "Common Stock" },
      { providerId: "test", symbol: "0011", name: "Hang Seng Bank Limited", exchange: "HKEX", currency: "HKD", type: "Common Stock",
        withdrawal: { on: "2026-01-27", reason: "Privatised by The Hongkong and Shanghai Banking Corporation Limited" } },
    ],
    getQuote: async (symbol) => { throw new Error(`No quote for ${symbol}`); },
  });
  const deps = { store, dataProvider };
  expect(await notTradedMessage(await resolveCliListing("0011", "HKEX", deps), deps))
    .toBe("0011:HKEX (Hang Seng Bank Limited): Delisted Jan 27, 2026 (Privatised by The Hongkong and Shanghai Banking Corporation Limited).");
  // Named among the code's listings with the day it went; Brite-Tech's line trades.
  expect((await listingVenues("0011", deps)).map((venue) => venue.name))
    .toEqual(["Brite-Tech Berhad", "Hang Seng Bank Limited · Delisted Jan 27, 2026"]);
  expect(await notTradedMessage(await resolveCliListing("0011", "BURSAMY", deps), deps)).toBeNull();
});

test("a company's name typed where any command takes a symbol is read as quote reads it, and words typed apart as one name first", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  // As search and quotes answered on 11 Nov 2026: MTN is Vail Resorts in New York, MTN Group's home line is MTN on the JSE,
  // "Group" alone reads as UnitedHealth Group, and nothing trades as NASPERS or GROUP.
  const line = (symbol: string, name: string, exchange: string, home = false) =>
    ({ providerId: "test", symbol, name, exchange, type: "Common Stock", currency: "USD", ...home ? { homeListing: true } : {} });
  const answers: Record<string, ReturnType<typeof line>[]> = {
    naspers: [line("NPN", "Naspers Limited", "JSE", true)],
    group: [line("UNH", "UnitedHealth Group Incorporated", "NYSE", true)],
    "mtn group": [line("MTN", "MTN Group Ltd.", "JSE", true), line("MTNOF", "MTN Group Ltd.", "OTC")],
    "elbit systems": [line("ESLT", "Elbit Systems Ltd.", "NASDAQ", true), line("ESLT", "Elbit Systems Ltd.", "TASE")],
  };
  answers.elbit = answers["elbit systems"]!;
  const quoted = new Set(["MTN", "AAPL", "MSFT", "NPN:JSE", "UNH:NYSE", "MTN:JSE", "ESLT:NASDAQ"]);
  const searched: string[] = [];
  const dataProvider = createTestDataProvider({
    search: async (query) => {
      searched.push(query);
      return answers[query.trim().toLowerCase()] ?? [];
    },
    getQuote: async (symbol, exchange) => {
      const key = exchange ? `${symbol}:${exchange}` : symbol;
      if (!quoted.has(key) && !quoted.has(symbol)) throw new Error(`No quote provider available for ${symbol}`);
      return createTestQuote({ symbol, currency: "USD" });
    },
  });
  const deps = { store, dataProvider };
  // `history Naspers`, `valuation Leumi`: the word is its company's listing, saying so.
  const naspers = await resolveCliListing("Naspers", undefined, deps);
  expect(naspers.key).toBe("NPN:JSE");
  expect(naspers.readAs).toBe('Read "Naspers" as NPN:JSE (Naspers Limited).');
  // A real ticker wins over a name; `quote`, which reads names after its own request, can leave words to it.
  expect((await resolveCliListing("MTN", undefined, deps)).key).toBe("MTN");
  expect((await resolveCliListing("Naspers", undefined, deps, { companyWord: false })).key).toBe("NASPERS");

  // "MTN Group": Group alone is read as UnitedHealth, so the words are tried together first, and are MTN Group.
  const read = async (words: string[]) => Promise.all(words.map(async (typed) => ({ typed, listing: await resolveCliListing(typed, undefined, deps) })));
  const joined = await joinCompanyNameWords(await read(["MTN", "Group"]), deps);
  expect(joined).toHaveLength(1);
  expect(joined[0]).toMatchObject({ typed: "MTN Group", joined: { key: "MTN:JSE", readAs: 'Read "MTN Group" as MTN:JSE (MTN Group Ltd.).' } });
  // A company listed twice under one symbol names its other line.
  const elbit = await joinCompanyNameWords(await read(["Elbit", "Systems"]), deps);
  expect(elbit.map((entry) => "joined" in entry ? entry.joined.readAs : entry.typed))
    .toEqual(['Read "Elbit Systems" as ESLT:NASDAQ (Elbit Systems Ltd.); also ESLT:TASE.']);
  // Tickers typed apart are never a name, and cost no search.
  searched.length = 0;
  const tickers = await joinCompanyNameWords(await read(["AAPL", "MSFT"]), deps);
  expect(tickers.map((entry) => "joined" in entry ? entry.typed : entry.listing?.key)).toEqual(["AAPL", "MSFT"]);
  expect(searched).toEqual([]);
  // A word read as a name with no neighbour that makes one keeps its own reading.
  const alone = await joinCompanyNameWords(await read(["AAPL", "Naspers"]), deps);
  expect(alone.map((entry) => "joined" in entry ? entry.typed : entry.listing?.key)).toEqual(["AAPL", "NPN:JSE"]);
  // A word shaped as a ticker (BRK.B) is never part of a name.
  searched.length = 0;
  await joinCompanyNameWords(await read(["BRK.B", "Naspers"]), deps);
  expect(searched.filter((query) => query.includes(" "))).toEqual([]);
  // The runs around a word are searched at once, at most six: its two- and three-word runs, then one of four.
  searched.length = 0;
  let open = 0;
  let most = 0;
  const slow = { ...dataProvider, search: async (query: string) => {
    open += 1;
    most = Math.max(most, open);
    await Bun.sleep(5);
    open -= 1;
    return dataProvider.search(query);
  } };
  const words = await read(["Alpha", "Beta", "Gamma", "Naspers", "Delta", "Epsilon", "Zeta"]);
  searched.length = 0;
  await joinCompanyNameWords(words, { dataProvider: slow });
  expect(searched).toEqual(expect.arrayContaining([
    "Gamma Naspers", "Naspers Delta", "Beta Gamma Naspers", "Gamma Naspers Delta", "Naspers Delta Epsilon", "Alpha Beta Gamma Naspers",
  ]));
  for (const run of ["Beta Gamma Naspers Delta", "Gamma Naspers Delta Epsilon", "Naspers Delta Epsilon Zeta"]) expect(searched).not.toContain(run);
  expect(most).toBeGreaterThan(1);
});
