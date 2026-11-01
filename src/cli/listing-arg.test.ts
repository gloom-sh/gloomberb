import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import {
  listCoinNotes, ListingArgError, listingChoiceNote, listingVenues, loadForListing, notTradedMessage, parseListingArg, resolveCliListing,
} from "./listing-arg";
import { LISTING_SEARCH_LIMIT } from "../tickers/search";
import { FUTURES_CONTRACTS } from "../market-data/futures-board";

const persistences: AppPersistence[] = [];

afterEach(() => {
  for (const persistence of persistences.splice(0)) persistence.close();
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
