import { describe, expect, jest, test } from "bun:test";
import type { DataProvider } from "../../types/data-provider";
import type { InstrumentSearchResult } from "../../types/instrument";
import type { TickerRecord } from "../../types/ticker";
import { createTestDataProvider } from "../../test-support/data-provider";
import {
  AmbiguousTickerError,
  buildTickerSearchCandidates,
  createLocalTickerSearchCandidates,
  findExactTickerSearchMatch,
  listingChoiceQuery,
  normalizeTickerInput,
  rankTickerSearchItems,
  resolveTickerSearch,
  searchTickerCandidates,
  upsertTickerFromSearchResult,
} from "./index";
import { createTestTicker } from "../../test-support/ticker";
import { resolveManualPositionCurrency } from "../../portfolio/mutations";
import { parsePublicTickerKey } from "../../utils/exchanges";
import { ProviderBusyError } from "../../sources/provider-errors";

function makeSearchResult(
  symbol: string,
  name = symbol,
  overrides: Partial<InstrumentSearchResult> = {},
): InstrumentSearchResult {
  return {
    providerId: "test",
    symbol,
    name,
    exchange: "NASDAQ",
    type: "EQUITY",
    ...overrides,
  };
}

function makeDataProvider(results: InstrumentSearchResult[]): DataProvider {
  return createTestDataProvider({
    id: "test",
    search: async () => results,
  });
}

describe("ticker-search utilities", () => {
  test("duplicate bare symbols follow verified quote identity independent of catalogue order", async () => {
    for (const [symbol, venue, currency, providerCurrency] of [
      ["GLD", "NYSE", "USD", "USD"],
      ["VOD", "LSE", "GBP", "GBp"],
      ["7203", "TYO", "JPY", "JPY"],
    ]) {
      const wanted = makeSearchResult(symbol!, "Exact listing", { exchange: venue, currency: providerCurrency });
      const other = makeSearchResult(symbol!, "Other listing", { exchange: "BYMA", currency: "ARS" });
      for (const results of [[other, wanted], [wanted, other]]) {
        const quoteCalls: Parameters<DataProvider["getQuote"]>[] = [];
        const resolved = await resolveTickerSearch({ query: symbol, activeTicker: null, tickers: new Map(),
          searchContext: { brokerId: "ibkr", brokerInstanceId: "research-account", preferBroker: true, interactive: true, onPartial: () => {} },
          dataProvider: createTestDataProvider({ search: async () => results, getQuote: async (...args) => {
            quoteCalls.push(args);
            return { symbol: symbol!, listingExchangeName: venue, currency: currency!, price: 100, lastUpdated: 1, change: 0, changePercent: 0 };
          } }),
        });
        expect(resolved).toMatchObject({ kind: "provider", result: { exchange: venue, currency } });
        expect(quoteCalls).toEqual([[symbol, "", { brokerId: "ibkr", brokerInstanceId: "research-account" }]]);
      }
    }
  });

  test("one symbol's companies follow the search order, a saved one first", () => {
    // /market/search?q=NET and q=GLD order, captured 2026-10-08.
    const netcall = makeSearchResult("NET", "Netcall Plc", { exchange: "LSE", currency: "GBp" });
    const cloudflare = makeSearchResult("NET", "Cloudflare, Inc. Class A Common Stock", { exchange: "NYSE", currency: "USD" });
    const venues = (query: string, results: InstrumentSearchResult[], tickers = new Map<string, TickerRecord>()) =>
      buildTickerSearchCandidates({ query, tickers, providerResults: results, totalLimit: 12 })
        .filter((item) => parsePublicTickerKey(item.symbol).symbol === query)
        .map((item) => item.exchangeLabel);
    // "Netcall" starts with NET, which used to put London first.
    expect(venues("NET", [cloudflare, { ...cloudflare, exchange: "BMV" }, netcall])).toEqual(["NYSE", "BMV", "LSE"]);
    // The stock boost used to put a penny miner above the gold ETF.
    expect(venues("GLD", [
      makeSearchResult("GLD", "SPDR Gold Shares", { exchange: "ARCA", type: "ETF" }),
      makeSearchResult("GLD", "SPDR Gold Shares", { exchange: "BYMA", type: "ETF" }),
      makeSearchResult("GLD", "Gold Finder Resources Ltd.", { exchange: "TSXV", type: "Common Stock" }),
    ])).toEqual(["ARCA", "BYMA", "TSXV"]);
    const saved = createTestTicker("NET", "Netcall Plc", { exchange: "LSE", currency: "GBP" });
    expect(venues("NET", [cloudflare, netcall], new Map([["NET", saved]]))).toEqual(["LSE", "NYSE"]);
  });

  test("a trailing colon lists every venue, even under a saved symbol", async () => {
    const netcall = makeSearchResult("NET", "Netcall", { exchange: "LSE", currency: "GBP" });
    const cloudflare = makeSearchResult("NET", "Cloudflare", { exchange: "NYSE", currency: "USD" });
    let quoteCalls = 0;
    const dataProvider = createTestDataProvider({
      search: async () => [cloudflare, netcall],
      getQuote: async () => { quoteCalls++; throw new Error("no quote needed"); },
    });
    const saved = createTestTicker("NET", "Netcall", { exchange: "LSE", currency: "GBP" });
    const tickers = new Map([[saved.metadata.ticker, saved]]);
    const error = await resolveTickerSearch({ query: "net:", activeTicker: null, tickers, dataProvider }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AmbiguousTickerError);
    expect(error.query).toBe("NET:");
    expect(error.listings).toEqual(["NET:XNYS", "NET:XLON"]);
    // A bare symbol is its US listing, whatever listing abroad is saved under it.
    expect(await resolveTickerSearch({ query: "NET", activeTicker: null, tickers, dataProvider }))
      .toMatchObject({ kind: "provider", result: { name: "Cloudflare", exchange: "NYSE" } });
    expect(await resolveTickerSearch({ query: "NET:XNYS", activeTicker: null, tickers, dataProvider }))
      .toMatchObject({ kind: "provider", result: { name: "Cloudflare", exchange: "NYSE" } });
    expect(quoteCalls).toBe(0);
    expect(listingChoiceQuery("net:n")).toEqual({ symbol: "NET", suffix: "N" });
    expect(listingChoiceQuery("ES=F:")).toBeNull();
  });

  test("the line the service marks as a company's home leads a symbol's choices, before another company's lines abroad", async () => {
    // /market/search?q=YAR on 2026-10-30: `quote YAR` offered Americold's four German lines first and Yara's own line last.
    const dataProvider = createTestDataProvider({
      search: async () => [
        makeSearchResult("YAR", "Americold Realty Trust, Inc.", { exchange: "MUNICH" }),
        makeSearchResult("YAR", "Americold Realty Trust Inc.", { exchange: "HANOVER" }),
        makeSearchResult("YAR", "Yari Minerals Limited", { exchange: "ASX" }),
        { ...makeSearchResult("YAR", "Yara International ASA", { exchange: "OSL", currency: "NOK" }), homeListing: true },
      ],
      getQuote: async () => { throw new Error("NOT_FOUND"); },
    });
    const error = await resolveTickerSearch({ query: "YAR", activeTicker: null, tickers: new Map(), dataProvider }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AmbiguousTickerError);
    expect(error.listings[0]).toMatch(/^YAR:(OSL|XOSL)$/);
    expect(error.listings).toHaveLength(4);
  });

  test("ambiguous symbols require venue, currency and exact quote evidence", async () => {
    const results = [makeSearchResult("GLD", "SPDR", { exchange: "BYMA", currency: "ARS" }),
      makeSearchResult("GLD", "SPDR", { exchange: "NYSE", currency: "USD" })];
    const quote = { symbol: "GLD", listingExchangeName: "NYSE", currency: "USD", price: 400, lastUpdated: 1, change: 0, changePercent: 0 };
    for (const invalid of [null, { ...quote, listingExchangeName: undefined }, { ...quote, currency: "ARS" },
      { ...quote, symbol: "GLDM" }, { ...quote, price: Number.NaN }, { ...quote, lastUpdated: 0 }]) {
      await expect(resolveTickerSearch({ query: "GLD", activeTicker: null, tickers: new Map(),
        dataProvider: createTestDataProvider({ search: async () => results, getQuote: async () => {
          if (!invalid) throw new Error("Quote unavailable");
          return invalid;
        } }),
      })).rejects.toBeInstanceOf(AmbiguousTickerError);
    }
  });

  test("a bare symbol's quote on a US exchange is its one US listing, whichever venue the feed labels it with", async () => {
    // /market/search?q=ET and the bare quotes, captured 2026-10-11: the feed labels ET's NYSE line
    // NYSE American, and Cboe BZX funds BTS.
    const quote = (listingExchangeName: string) => ({ symbol: "ET", listingExchangeName, currency: "USD", price: 20.41, lastUpdated: 1, change: 0, changePercent: 0 });
    const resolve = (results: InstrumentSearchResult[], listingExchangeName: string) => resolveTickerSearch({ query: "ET", activeTicker: null,
      tickers: new Map(), dataProvider: createTestDataProvider({ search: async () => results, getQuote: async () => quote(listingExchangeName) }) });
    const energyTransfer = [makeSearchResult("ET", "Energy Transfer LP", { exchange: "NYSE", currency: "USD" }),
      makeSearchResult("ET", "Energy Transfer LP", { exchange: "IEX", currency: "USD" }),
      makeSearchResult("ET", "Evertz Technologies Ltd.", { exchange: "TSX", currency: "CAD" })];
    expect(await resolve(energyTransfer, "AMEX"))
      .toMatchObject({ kind: "provider", result: { exchange: "NYSE" }, otherListings: ["ET:IEX", "ET:XTSE"] });
    expect(await resolve([makeSearchResult("ET", "Fund", { exchange: "BATS", currency: "USD" }),
      makeSearchResult("ET", "Fund", { exchange: "IEX", currency: "USD" })], "BTS"))
      .toMatchObject({ result: { exchange: "BATS" }, otherListings: ["ET:IEX"] });
    // A US quote is no evidence for a listing abroad, nor between two US lines search disagrees on.
    await expect(resolve(energyTransfer.slice(1), "NYSE")).rejects.toBeInstanceOf(AmbiguousTickerError);
    await expect(resolve([...energyTransfer, makeSearchResult("ET", "Energy Transfer LP", { exchange: "ARCA", currency: "USD" })], "AMEX"))
      .rejects.toBeInstanceOf(AmbiguousTickerError);
  });

  test("explicit venues and saved identities bypass default quote disambiguation", async () => {
    const results = [makeSearchResult("VOD", "Vodacom", { exchange: "JSE", currency: "ZAR" }),
      makeSearchResult("VOD", "Vodafone", { exchange: "LSE", currency: "GBP" }),
      makeSearchResult("VOD", "Vodafone ADR", { exchange: "NASDAQ", currency: "USD" })];
    let quoteCalls = 0;
    const dataProvider = createTestDataProvider({ search: async () => results, getQuote: async () => {
      quoteCalls++; throw new Error("Quote unavailable");
    } });
    for (const [query, exchange] of [["VOD:XLON", "LSE"], ["VOD:LSE", "LSE"], ["VOD:JSE", "JSE"], ["VOD:NASDAQ", "NASDAQ"]]) {
      expect(await resolveTickerSearch({ query, activeTicker: null, tickers: new Map(), dataProvider }))
        .toMatchObject({ kind: "provider", result: { exchange } });
    }
    const resolveSaved = (...saved: ReturnType<typeof createTestTicker>[]) => resolveTickerSearch({
      query: "VOD", activeTicker: null, tickers: new Map(saved.map((ticker) => [ticker.metadata.ticker, ticker])), dataProvider,
    });
    const london = createTestTicker("VOD", "Saved Vodafone", { exchange: "LSE", currency: "GBP" });
    const newYork = createTestTicker("VOD:XNAS", "Saved Vodafone ADR", { exchange: "NASDAQ", currency: "USD" });
    // A listing abroad saved under the bare key gives way to the US one: saved beside it, else search's.
    expect(await resolveSaved(london, newYork)).toMatchObject({ kind: "local", ticker: newYork });
    expect(await resolveSaved(london)).toMatchObject({ kind: "provider", result: { name: "Vodafone ADR", exchange: "NASDAQ" } });
    expect(quoteCalls).toBe(0);
    // With no US listing, the saved one abroad is the symbol's.
    const vodacom = createTestTicker("VOD", "Saved Vodacom", { exchange: "JSE", currency: "ZAR" });
    expect(await resolveTickerSearch({ query: "VOD", activeTicker: null, tickers: new Map([["VOD", vodacom]]),
      dataProvider: createTestDataProvider({ search: async () => results.slice(0, 2) }) })).toMatchObject({ kind: "local", ticker: vodacom });
  });

  test("share-class aliases keep the requested security when duplicate venues need a quote", async () => {
    expect(await resolveTickerSearch({ query: "BRK-B", activeTicker: null, tickers: new Map(),
      dataProvider: createTestDataProvider({
        search: async () => [makeSearchResult("BRK.B", "Berkshire", { exchange: "BYMA", currency: "ARS" }),
          makeSearchResult("BRK.B", "Berkshire", { exchange: "NYSE", currency: "USD" })],
        getQuote: async () => ({ symbol: "BRK-B", listingExchangeName: "NYSE", currency: "USD", price: 400, lastUpdated: 1, change: 0, changePercent: 0 }),
      }),
    })).toMatchObject({ kind: "provider", symbol: "BRK.B", result: { exchange: "NYSE" } });
  });

  test("verifies omitted crypto symbols before selecting a punctuation alias on another venue", async () => {
    const alias = makeSearchResult("SHIB/USD", "SHIBA INU US Dollar", { type: "Digital Currency", exchange: "COINBASE PRO" });
    const quote = { symbol: "SHIB-USD", instrumentType: "CRYPTOCURRENCY", price: 0.00000509, currency: "USD", lastUpdated: 1789077420000,
      change: 0, changePercent: 0, listingExchangeName: "CCC" };
    const dataProvider = createTestDataProvider({ search: async () => [alias], getQuote: async () => quote });
    const savedAlias = createTestTicker("SHIB/USD", "SHIBA INU US Dollar", { exchange: "COINBASE PRO", assetCategory: "Digital Currency" });
    const tickers = new Map([["SHIB/USD", savedAlias]]);
    expect(await resolveTickerSearch({ query: "SHIB-USD", activeTicker: null, tickers, dataProvider }))
      .toMatchObject({ kind: "provider", symbol: "SHIB-USD", result: { exchange: "CCC", currency: "USD", type: "CRYPTOCURRENCY" } });
    const candidates = await searchTickerCandidates({ query: "SHIB-USD", tickers, dataProvider });
    expect(candidates[0]?.symbol).toBe("SHIB-USD");
    expect(findExactTickerSearchMatch(candidates, "SHIB-USD")?.symbol).toBe("SHIB-USD");
    expect(await resolveTickerSearch({ query: "SHIB-USD:CCC", activeTicker: null, tickers, dataProvider }))
      .toMatchObject({ kind: "provider", result: { exchange: "CCC" } });
    expect(await resolveTickerSearch({ query: "SHIB-USD:COINBASE PRO", activeTicker: null, tickers, dataProvider })).toBeNull();
    // A hyphen alone cannot establish an instrument's type or its identity.
    for (const invalid of [{ instrumentType: "EQUITY" }, { symbol: "OTHER-USD" }, { price: 0 }, { price: -1 }, { instrumentType: undefined }]) {
      expect(await resolveTickerSearch({ query: "SHIB-USD", activeTicker: null, tickers: new Map(),
        dataProvider: createTestDataProvider({ search: async () => [alias], getQuote: async () => ({ ...quote, ...invalid }) }) })).toBeNull();
    }
  });

  test("prefers literal provider symbols without losing equity share-class aliases", async () => {
    const results = [makeSearchResult("SHIB/USD", "Shiba Inu", { type: "Digital Currency", exchange: "COINBASE PRO" }),
      makeSearchResult("SHIB-USD", "Shiba Inu", { type: "CRYPTOCURRENCY", exchange: "CCC", currency: "USD" })];
    expect(await resolveTickerSearch({ query: "SHIB-USD", activeTicker: null, tickers: new Map(), dataProvider: makeDataProvider(results) }))
      .toMatchObject({ symbol: "SHIB-USD" });
    expect(await resolveTickerSearch({ query: "BRK-B", activeTicker: null, tickers: new Map(),
      dataProvider: makeDataProvider([makeSearchResult("BRK.B", "Berkshire", { exchange: "NYSE" })]) }))
      .toMatchObject({ symbol: "BRK.B" });
  });

  test("preserves futures, FX and index identity across saved and provider search matches", async () => {
    for (const symbol of ["ES=F", "6J=F", "JPY=X", "EURUSD=X", "EUR/USD", "^GSPC"]) {
      const lookalike = symbol.replace(/[^A-Z0-9]/g, "");
      const tickers = new Map([[lookalike, createTestTicker(lookalike)]]);
      const queries: string[] = [];
      const dataProvider = createTestDataProvider({
        search: async (query) => {
          queries.push(query);
          return [makeSearchResult(lookalike), makeSearchResult(symbol)];
        },
      });
      const resolved = await resolveTickerSearch({ query: symbol, activeTicker: null, tickers, dataProvider });
      expect(resolved).toMatchObject({ kind: "provider", symbol });
      expect(queries).not.toContain(lookalike);
      const candidates = await searchTickerCandidates({ query: symbol, tickers, dataProvider });
      expect(candidates[0]?.symbol).toBe(symbol);
      expect(candidates.some((candidate) => candidate.symbol === lookalike)).toBe(false);
      expect(findExactTickerSearchMatch([{ label: lookalike }], symbol)).toBeNull();
      expect(findExactTickerSearchMatch([{ label: symbol }], lookalike)).toBeNull();
    }
    expect(findExactTickerSearchMatch([{ label: "EURUSD=X" }], "EUR/USD")?.label).toBe("EURUSD=X");
    expect(findExactTickerSearchMatch([{ label: "USD/JPY" }], "JPY=X")?.label).toBe("USD/JPY");
    expect(findExactTickerSearchMatch([{ label: "JPY/USD" }], "JPY=X")).toBeNull();
  });

  describe("a commodity typed by its name", () => {
    // /market/search, captured 2026-10-17: the server leads with the benchmark future and tags it with the names it answers to.
    const future = (symbol: string, name: string, exchange: string, searchAliases: string[]) =>
      makeSearchResult(symbol, name, { exchange, type: "FUTURE", currency: "USD", searchAliases });
    const stock = (symbol: string, name: string, exchange: string, type = "Common Stock") => makeSearchResult(symbol, name, { exchange, type });
    const gold = future("GC=F", "Gold", "CMX", ["Gold"]);
    const wti = future("CL=F", "WTI Crude Oil", "NYM", ["WTI Crude Oil", "WTI", "WTI Crude", "Crude Oil", "Crude", "Oil"]);
    const brent = future("BZ=F", "Brent Crude Oil", "NYM", ["Brent Crude Oil", "Brent", "Brent Crude", "Crude Oil", "Crude", "Oil"]);
    const build = (query: string, providerResults: InstrumentSearchResult[], totalLimit = 30) =>
      buildTickerSearchCandidates({ query, tickers: new Map(), providerResults, totalLimit });
    const order = (query: string, providerResults: InstrumentSearchResult[]) =>
      build(query, providerResults).map((candidate) => `${candidate.label}:${candidate.exchangeLabel}`);

    test("the benchmark future is the first result, ahead of the ETCs, warrants and companies sharing the word", () => {
      const bz = future("BZ=F", "Brent Crude Oil", "NYM", ["Brent Crude Oil", "Brent", "Brent Crude", "Crude Oil", "Crude", "Oil"]);
      const brentRows = [bz,
        stock("BRENT", "CoreShares Brent Oil ETC", "BIT", "ETF"), stock("BRENT", "Leonteq Brent Crude Oil ETP", "SWX", "ETF"),
        stock("F96878", "Brent Crude Oil Future", "BIT", "Warrant"), stock("F96879", "Brent Crude Oil Future Call Warrant", "BIT", "Warrant")];
      expect(order("brent", brentRows)[0]).toBe("BZ=F:NYM");
      // Wherever the server put it.
      expect(order("brent", [...brentRows.slice(1), bz])[0]).toBe("BZ=F:NYM");

      const wtiRows = [wti, stock("WTI", "WTI Oil Exchange Traded Commodity", "LSE", "ETF"), stock("WTI", "W&T Offshore Inc", "NYSE"),
        stock("WTII", "Water Technologies International,Inc.", "OTC")];
      // The exact tickers follow in the order the server gave them.
      expect(order("wti", wtiRows).slice(0, 3)).toEqual(["CL=F:NYM", "WTI:LSE", "WTI:NYSE"]);

      const goldRows = [gold, stock("GOLD", "Gold.com, Inc.", "NYSE"), stock("GOLD", "GoldMining Inc.", "TSX"),
        stock("GOLD", "Amundi Physical Gold ETC", "AMS", "ETF")];
      expect(order("gold", goldRows).slice(0, 2)).toEqual(["GC=F:CMX", "GOLD:NYSE"]);
      // The category says what it is: a derivative, listed first, and the company stays its listing.
      expect(build("gold", goldRows).map((candidate) => [candidate.label, candidate.category]).slice(0, 2))
        .toEqual([["GC=F", "Funds & Derivatives"], ["GOLD", "Primary Listing"]]);

      const silverRows = [future("SI=F", "Silver", "CMX", ["Silver"]), stock("SILVER", "Aditya Birla Sun Life Silver ETF", "NSE", "ETF"),
        stock("SLV", "iShares Silver Trust", "ARCA", "ETF")];
      expect(order("silver", silverRows)[0]).toBe("SI=F:CMX");

      const gasRows = [future("NG=F", "Natural Gas", "NYM", ["Natural Gas", "NatGas", "Nat Gas"]),
        stock("NGS", "Natural Gas Services Group, Inc.", "NYSE"), stock("BNQ9", "Natural Gas ETC BNP Paribas", "XETRA", "ETF")];
      for (const query of ["natural gas", "Natural Gas", "natgas", "nat gas"]) expect(order(query, gasRows)[0], query).toBe("NG=F:NYM");
    });

    test("oil and crude lead with WTI, then Brent, in the order the server sent them", () => {
      const rows = [wti, brent, stock("OIL", "Oil India Limited", "BSE"), stock("OIL", "Onyx Spot Return Crude Oil", "LSE", "ETF")];
      for (const query of ["oil", "OIL", "crude", "Crude Oil", "crude oil futures"]) {
        expect(order(query, rows).slice(0, 2), query).toEqual(["CL=F:NYM", "BZ=F:NYM"]);
        expect(order(query, [brent, wti, ...rows.slice(2)]).slice(0, 2), query).toEqual(["BZ=F:NYM", "CL=F:NYM"]);
      }
      expect(order("oil", rows).slice(2)).toEqual(expect.arrayContaining(["OIL:BSE"]));
    });

    test("an exact ticker keeps its company: AAPL is not a commodity, and GOLD still lists Gold.com right behind the metal", () => {
      const apple = [stock("AAPL", "Apple Inc.", "NASDAQ"), stock("APLE", "Apple Hospitality REIT, Inc.", "NYSE")];
      expect(order("AAPL", apple)).toEqual(["AAPL:NASDAQ"]);
      expect(order("apple", [...apple, gold])).toEqual(["AAPL:NASDAQ", "APLE:NYSE"]);
      const goldRows = [gold, stock("GOLD", "Gold.com, Inc.", "NYSE"), stock("GOLD", "GoldMining Inc.", "TSX")];
      const candidates = build("GOLD", goldRows);
      expect(candidates.map((candidate) => candidate.label).slice(0, 2)).toEqual(["GC=F", "GOLD"]);
      expect(candidates.find((candidate) => candidate.label === "GOLD")).toMatchObject({ detail: expect.stringContaining("Gold.com"), category: "Primary Listing" });
    });

    test("only the name itself asks for the future: not another word, another kind of row, or a future typed by its symbol", () => {
      const rows = [stock("GDX", "VanEck Gold Miners ETF", "ARCA", "ETF"), stock("GOLD", "Gold.com, Inc.", "NYSE"), gold];
      for (const query of ["gold miners", "gold etf", "gold stock", "gol"]) {
        expect(order(query, rows)[0], query).not.toBe("GC=F:CMX");
      }
      expect(order("GC=F", rows)).toEqual(["GC=F:CMX"]);
      expect(order("gold futures", rows)[0]).toBe("GC=F:CMX");
      expect(order("gold FUT", rows)).toEqual(["GC=F:CMX"]);
      // A fund sent with the same name is not a future, and a server that sends no names changes nothing.
      const mislabeled = makeSearchResult("GLD", "SPDR Gold Shares", { exchange: "ARCA", type: "ETF", searchAliases: ["Gold"] });
      expect(order("gold", [mislabeled, stock("GOLD", "Gold.com, Inc.", "NYSE")])[0]).toBe("GOLD:NYSE");
      const older = makeSearchResult("GC=F", "Gold", { exchange: "CMX", type: "FUTURE" });
      expect(order("gold", [stock("GOLD", "Gold.com, Inc.", "NYSE"), older])).toEqual(["GOLD:NYSE", "GC=F:CMX"]);
    });
  });

  describe("an index, rate, volatility or crypto market typed with futures", () => {
    // /market/search with the server change: the full-size future leads and carries the names it answers to.
    const future = (symbol: string, name: string, exchange: string, searchAliases?: string[]) =>
      makeSearchResult(symbol, name, { exchange, type: "FUTURE", currency: "USD", searchAliases });
    const row = (symbol: string, name: string, exchange: string, type: string) => makeSearchResult(symbol, name, { exchange, type });
    const order = (query: string, providerResults: InstrumentSearchResult[]) =>
      buildTickerSearchCandidates({ query, tickers: new Map(), providerResults, totalLimit: 30 }).map((candidate) => `${candidate.label}:${candidate.exchangeLabel}`);
    const es = future("ES=F", "E-Mini S&P 500", "CME", ["E-Mini S&P 500", "S&P 500", "S&P", "SPX", "SP500"]);
    const nq = future("NQ=F", "Nasdaq 100 Dec 26", "CME", ["E-Mini Nasdaq 100", "Nasdaq 100", "Nasdaq", "NDX"]);
    const vx = future("VX1", "VIX Futures 1st generic", "CFE", ["VIX Futures", "VIX"]);

    test("the full-size future is the first result, ahead of the index, the funds and the mini and micro contracts", () => {
      const spRows = [es, row("^SPXFPE", "S&P 500 Futures Index (0930-160", "SNP", "INDEX"), row("^SP500FER", "S&P 500 Futures Index ER", "SNP", "INDEX"),
        future("NES=F", "E-nano S&P 500 Futures,Dec-2026", "CME"), future("MES=F", "Micro E-Mini S&P 500", "CME")];
      for (const query of ["s&p 500 futures", "S&P Futures", "spx futures"]) expect(order(query, spRows)[0], query).toBe("ES=F:CME");
      // "nasdaq" is a venue and "futures" a type to the ranking: no text is left for the future's name to match.
      const nasdaqRows = [nq, row("304940", "Samsung Kodex Us Nasdaq 100 Futures Etf(H)", "KRX", "ETF"), future("MNQ=F", "Micro E-Mini Nasdaq 100", "CME")];
      expect(order("nasdaq futures", nasdaqRows)[0]).toBe("NQ=F:CME");
      expect(order("nasdaq futures", [...nasdaqRows.slice(1), nq])[0]).toBe("NQ=F:CME");
      // VIX has no continuous symbol: the front generic leads, and the volatility index and its ETFs follow.
      const vixRows = [vx, row("^LONGVOL", "Long VIX Futures Index", "WCB", "INDEX"), row("UVIX", "2x Long VIX Futures ETF", "BTS", "ETF")];
      expect(order("vix futures", vixRows)).toEqual(["VX1:CFE", "^LONGVOL:WCB", "UVIX:BTS"]);
      const ten = future("ZN=F", "10-Year T-Note", "CBT", ["10-Year T-Note", "10 Year Note", "10 Year Treasury Note", "10 Year Treasury", "Treasury Note", "T-Note", "Treasury", "Treasuries"]);
      expect(order("10 year note futures", [row("304660", "Samsung Kodex Ultra Treasury Bond Futures(H) ETF", "KRX", "ETF"), ten])[0]).toBe("ZN=F:CBT");
    });

    test("a bare name, a fund and a stock sent with the same word keep the rank they had", () => {
      const index = row("^GSPC", "S&P 500", "SNP", "INDEX");
      const fund = row("SPY", "SPDR S&P 500 ETF Trust", "ARCA", "ETF");
      expect(order("s&p 500", [index, fund, future("ES=F", "E-Mini S&P 500", "CME")]).slice(0, 3)).toEqual(["^GSPC:SNP", "SPY:ARCA", "ES=F:CME"]);
      // The server names no future for a bare "vix", whose alias list is the index's own.
      const vixIndex = makeSearchResult("^VIX", "CBOE Volatility Index", { exchange: "WCB", type: "INDEX", searchAliases: ["VIX", "VIX Index"] });
      expect(order("vix", [vixIndex, row("VIXY", "ProShares VIX Short-Term Futures ETF", "BATS", "ETF")])[0]).toBe("^VIX:WCB");
      // A stock coded like a generic is no future: it does not share the lead, wherever the server put it.
      const stock = makeSearchResult("ABC1", "ABC One Inc.", { exchange: "NYSE", type: "Common Stock", searchAliases: ["VIX"] });
      expect(order("vix futures", [stock, vx])[0]).toBe("VX1:CFE");
    });
  });

  describe("an index typed by its code", () => {
    // /market/search?q=IBOV, captured 2026-10-12: the server leads with the index and tags it with the codes it answers to.
    const ibovespa = makeSearchResult("^BVSP", "Ibovespa", { exchange: "B3", type: "INDEX", searchAliases: ["IBOV", "IBOV Index"] });
    const ibovResults = [
      ibovespa,
      makeSearchResult("IBOV11", "IBOV11 Fund", { exchange: "B3", type: "Common Stock" }),
      makeSearchResult("159100", "ChinaAMC Bradesco Brazil IBOV ETF (QDII)", { exchange: "SZSE", type: "ETF" }),
      makeSearchResult("SPVT11", "Safra ETF IBOV EP Fi - RL", { exchange: "B3", type: "ETF" }),
      makeSearchResult("BOVA11", "iShares Ibovespa Fundo de Indice", { exchange: "B3", type: "ETF" }),
    ];
    const build = (query: string, providerResults: InstrumentSearchResult[]) =>
      buildTickerSearchCandidates({ query, tickers: new Map(), providerResults, totalLimit: 12 });

    test("leads as the primary listing ahead of the funds and the fund named for it", () => {
      for (const query of ["IBOV", "ibov", " Ibov ", "IBOV Index", "ibov  index"]) {
        const candidates = build(query, ibovResults);
        expect(candidates[0], query).toMatchObject({ label: "^BVSP", category: "Primary Listing" });
        expect(candidates.filter((candidate) => candidate.category === "Primary Listing"), query).toHaveLength(1);
      }
    });

    test("only an index answers to its codes; a row of another type sent with the same aliases does not lead", () => {
      const asStock = ibovResults.map((result) => result === ibovespa ? { ...result, type: "EQUITY" } : result);
      expect(build("IBOV", asStock)[0]?.label).not.toBe("^BVSP");
    });

    test("a real ticker spelled as the code keeps the lead, the index follows it", () => {
      // /market/search?q=SPX, captured 2026-10-12: the S&P 500 comes after the companies that use SPX.
      const results = [
        makeSearchResult("SPX", "Space Exploration Technologies Corp.", { exchange: "XETRA", type: "Common Stock" }),
        makeSearchResult("SPX", "Spenda Limited", { exchange: "CXA", type: "Common Stock" }),
        makeSearchResult("SPXC", "SPX Technologies, Inc.", { exchange: "NYSE", type: "Common Stock" }),
        makeSearchResult("^GSPC", "S&P 500", { exchange: "SNP", type: "INDEX", searchAliases: ["SPX", "SPX Index"] }),
      ];
      const candidates = build("SPX", results);
      expect(candidates.map((candidate) => [candidate.label, candidate.category])).toEqual([
        ["SPX", "Primary Listing"],
        ["SPX", "Other Listings"],
        ["^GSPC", "Other Listings"],
        ["SPXC", "Other Listings"],
      ]);
    });

    test("every other query keeps the order it had", () => {
      // The index's codes move it only for a query that equals one: the same list answered these the same way before.
      const results = [
        makeSearchResult("AAPL", "Apple Inc.", { type: "Common Stock" }),
        makeSearchResult("AAPL", "Apple Inc.", { exchange: "BMV", type: "Common Stock" }),
        makeSearchResult("APLE", "Apple Hospitality REIT, Inc.", { exchange: "NYSE", type: "Common Stock" }),
        makeSearchResult("BRK.B", "Berkshire Hathaway Inc. Class B", { exchange: "NYSE", type: "Common Stock", searchAliases: ["BRK.B", "BRK B", "BRKB"] }),
        makeSearchResult("F", "Ford Motor Company", { exchange: "NYSE", type: "Common Stock" }),
        makeSearchResult("7203", "Toyota Motor Corporation", { exchange: "TSE", type: "Common Stock" }),
        makeSearchResult("^GSPC", "S&P 500", { exchange: "SNP", type: "INDEX", searchAliases: ["SPX", "SPX Index"] }),
        ibovespa,
        makeSearchResult("BOVA11", "iShares Ibovespa Fundo de Indice", { exchange: "B3", type: "ETF" }),
        makeSearchResult("IBOV11", "IBOV11 Fund", { exchange: "B3", type: "Common Stock" }),
        makeSearchResult("SPY", "SPDR S&P 500 ETF Trust", { exchange: "ARCA", type: "ETF" }),
      ];
      const order = (query: string) => build(query, results).map((candidate) => `${candidate.label}:${candidate.exchangeLabel}`);
      expect(order("AAPL")).toEqual(["AAPL:NASDAQ", "AAPL:BMV"]);
      expect(order("apple")).toEqual(["AAPL:NASDAQ", "AAPL:BMV", "APLE:NYSE"]);
      expect(order("BOVA11")).toEqual(["BOVA11:B3"]);
      expect(order("ibovespa")).toEqual(["^BVSP:B3", "BOVA11:B3"]);
      expect(order("IBO")).toEqual(["IBOV11:B3", "^BVSP:B3", "BOVA11:B3", "BRK.B:NYSE"]);
      expect(order("BRK.B")).toEqual(["BRK.B:NYSE"]);
      expect(order("BRKB")).toEqual(["BRK.B:NYSE"]);
      expect(order("7203")).toEqual(["7203:TSE"]);
      expect(order("F")).toEqual(["F:NYSE", "IBOV11:B3", "SPY:ARCA", "BOVA11:B3"]);
      expect(order("S&P 500")).toEqual(["^GSPC:SNP", "SPY:ARCA"]);
    });
  });

  test("a pair named on its currency venue opens the pair search lists there", async () => {
    for (const [query, symbol] of [["EURUSD:CCY", "EURUSD=X"], ["EURUSD:FX", "EURUSD=X"], ["USDJPY:FX", "JPY=X"], ["EURGBP:CCY", "EURGBP=X"]]) {
      const dataProvider = makeDataProvider([
        makeSearchResult(symbol!, "Currency Pair", { exchange: "CCY", type: "CURRENCY" }),
        makeSearchResult(query!.split(":")[0]!, "Lookalike Fund", { exchange: "LSE", type: "ETF" }),
      ]);
      expect(await resolveTickerSearch({ query, activeTicker: null, tickers: new Map(), dataProvider }), query)
        .toMatchObject({ kind: "provider", symbol, result: { exchange: "CCY" } });
    }
  });

  test("retains the quote currency of FX catalogue rows and reuses saved qualified futures", async () => {
    for (const symbol of ["JPY=X", "USDJPY=X", "USD/JPY", "EUR/JPY"]) {
      expect(await resolveTickerSearch({
        query: symbol, activeTicker: null, tickers: new Map(),
        dataProvider: makeDataProvider([makeSearchResult(symbol, "Currency Pair", { type: "Physical Currency" })]),
      })).toMatchObject({ kind: "provider", result: { symbol, currency: "JPY" } });
    }
    const future = createTestTicker("ES=F:CME", "S&P 500 Futures", { exchange: "CME", assetCategory: "FUTURE" });
    for (const query of ["ES=F", "ES=F:CME"]) {
      expect(await resolveTickerSearch({
        query, activeTicker: null, tickers: new Map([[future.metadata.ticker, future]]),
        dataProvider: createTestDataProvider({ search: async () => { throw new Error("saved future should resolve locally"); } }),
      })).toMatchObject({ kind: "local", symbol: "ES=F:CME" });
    }
    expect(findExactTickerSearchMatch([{ label: "ES=F:CME" }], "ES=F:NYMEX")).toBeNull();
  });

  test("a futures board code finds its future first where no security uses the code, and right after the security otherwise", async () => {
    const asked: string[] = [];
    const dataProvider = createTestDataProvider({
      search: async (query) => {
        asked.push(query);
        if (query.endsWith("=F")) return [makeSearchResult(query, `${query} future`, { exchange: "NYM", type: "FUTURE" })];
        if (query === "TTF") return [makeSearchResult("TTFL", "Trident Texofab Ltd.", { exchange: "BSE", type: "Common Stock" })];
        return ["AMEX", "TSX", "NEO", "IEX"].map((exchange) => makeSearchResult("NG", "NovaGold Resources Inc.", { exchange, type: "Common Stock" }));
      },
    });
    const search = (query: string) => searchTickerCandidates({ query, tickers: new Map(), dataProvider });
    expect((await search("TTF")).map((item) => item.symbol)).toEqual(["TTF=F", "TTFL"]);
    expect(asked).toEqual(expect.arrayContaining(["TTF", "TTF=F"]));
    expect((await search("NG")).map((item) => `${item.symbol} ${item.result?.exchange}`).slice(0, 3)).toEqual(["NG AMEX", "NG=F NYM", "NG TSX"]);
    // Typed alone, TTF opens the future.
    expect(await resolveTickerSearch({ query: "ttf", activeTicker: null, tickers: new Map(), dataProvider })).toMatchObject({ kind: "provider", symbol: "TTF=F" });
  });

  test("a trailing class code keeps that class and also asks for its market spelling", async () => {
    const asked: string[] = [];
    const dataProvider = createTestDataProvider({
      search: async (query) => {
        asked.push(query);
        if (query === "ES=F") return [makeSearchResult("ES=F", "E-Mini S&P 500 Dec 26", { exchange: "CME", type: "FUTURE" })];
        return [
          makeSearchResult("ES", "Eversource Energy", { exchange: "NYSE", type: "Common Stock" }),
          makeSearchResult("ESR=F", "Euro Short-Term Rate Futures", { exchange: "CME", type: "FUTURE" }),
        ];
      },
    });
    const candidates = await searchTickerCandidates({ query: "ES FUT", tickers: new Map(), dataProvider, includeOptionContracts: false });
    expect(asked).toContain("ES=F");
    expect(asked).not.toContain("ES FUT");
    expect(candidates.map((item) => item.symbol).sort()).toEqual(["ES=F", "ESR=F"]);

    // The word ranking alone puts coins named "... BTC USD" ahead of BTC-USD.
    // CRYP keeps coins, and CUR keeps them too.
    const coinResults = [
      makeSearchResult("PBTC-USD", "pTokens BTC USD", { exchange: "CCC", type: "CRYPTOCURRENCY" }),
      makeSearchResult("BTC", "Grayscale Bitcoin Mini Trust ETF", { exchange: "ARCA", type: "ETF" }),
      makeSearchResult("BTC-USD", "Bitcoin USD", { exchange: "CCC", type: "CRYPTOCURRENCY" }),
    ];
    for (const query of ["BTC CRYP", "BTC CUR"]) {
      expect(buildTickerSearchCandidates({ query, tickers: new Map(), providerResults: coinResults })
        .map((item) => item.symbol)).toEqual(["BTC-USD", "PBTC-USD"]);
    }
    expect(buildTickerSearchCandidates({
      query: "EUR CRYP",
      tickers: new Map(),
      providerResults: [makeSearchResult("EURUSD=X", "EUR/USD", { type: "CURRENCY" })],
    })).toEqual([]);

    asked.length = 0;
    await searchTickerCandidates({
      query: "BTC CRYP",
      tickers: new Map(),
      dataProvider: createTestDataProvider({ search: async (query) => { asked.push(query); return []; } }),
    });
    expect(asked).toContain("BTC-USD");
    expect(asked).not.toContain("BTC CRYP");
  });

  test("a name ending in Fund keeps every fund, and ETF only exchange-traded ones", () => {
    // Full fund names end in "Fund" whether or not they trade on an exchange.
    const providerResults = [
      makeSearchResult("XLK", "Technology Select Sector SPDR Fund", { exchange: "ARCA", type: "ETF" }),
      makeSearchResult("VWELX", "Vanguard Wellington Fund Investor Shares", { exchange: "NASDAQ", type: "Mutual Fund" }),
      makeSearchResult("PDI", "PIMCO Dynamic Income Fund", { exchange: "NYSE", type: "Closed-end Fund" }),
      makeSearchResult("FUNDX", "Fund Holdings Inc", { exchange: "NYSE", type: "Common Stock" }),
    ];
    const symbols = (query: string) => buildTickerSearchCandidates({ query, tickers: new Map(), providerResults })
      .map((item) => item.symbol).sort();
    expect(symbols("Technology Select Sector SPDR Fund")).toEqual(["XLK"]);
    expect(symbols("Fund FUND")).toEqual(["PDI", "VWELX", "XLK"]);
    expect(symbols("Fund ETF")).toEqual(["XLK"]);
  });

  test("words before ETF also ask the whole query, whose funds of that kind lead in the server's order", async () => {
    const asked: string[] = [];
    const fund = (symbol: string, name: string, exchange: string, keyword?: string) => makeSearchResult(symbol, name, {
      exchange, type: "ETF", ...(keyword ? { searchKeywords: [keyword] } : {}),
    });
    // The whole query answers slower than the name: its rows still lead.
    const dataProvider = createTestDataProvider({
      search: async (query) => {
        asked.push(query);
        if (query === "spot bitcoin ETF") {
          await Bun.sleep(5);
          return [
            fund("IBIT", "iShares Bitcoin Trust ETF", "NASDAQ", "spot bitcoin etf"),
            fund("FBTC", "Fidelity Wise Origin Bitcoin Fund", "BATS", "spot bitcoin etf"),
            fund("3042", "ChinaAMC Bitcoin ETF (HKD counter)", "HKEX", "spot bitcoin etf"),
            fund("BTCK", "Spot Bitcoin", "ARCA"),
          ];
        }
        return [fund("BTCK", "Spot Bitcoin", "ARCA"), makeSearchResult("SPOT", "Spotify Technology", { exchange: "NYSE" })];
      },
    });
    const candidates = await searchTickerCandidates({
      query: "spot bitcoin ETF", tickers: new Map(), dataProvider, includeOptionContracts: false, totalLimit: 10,
    });
    expect(asked[0]).toBe("spot bitcoin ETF");
    expect(asked).toContain("spot bitcoin");
    // The funds of the words before ETF are the whole query's answer: asked once, not again as a theme.
    expect(asked.filter((query) => query.toLowerCase() === "spot bitcoin etf")).toHaveLength(1);
    expect(candidates.map((item) => item.symbol)).toEqual(["IBIT", "FBTC", "3042", "BTCK"]);

    // A symbol before ETF still finds itself first; a code with no words before it asks nothing whole.
    asked.length = 0;
    await searchTickerCandidates({ query: "ES FUT", tickers: new Map(), dataProvider, includeOptionContracts: false });
    expect(asked).not.toContain("ES FUT");
  });

  test.each(["ETF", "FUND"])("untagged whole-query rows cannot reorder exact IBIT listings with %s", async (suffix) => {
    const fund = (symbol: string, exchange: string) => makeSearchResult(symbol, "iShares Bitcoin Trust ETF", { exchange, type: "ETF" });
    const primary = fund("IBIT", "NASDAQ");
    const foreign = fund("IBIT", "ASX");
    const dataProvider = createTestDataProvider({
      search: async (query) => query.toUpperCase() === `IBIT ${suffix}`
        ? [fund("IBIT.XA", "CXA"), foreign]
        : [primary, foreign, fund("IBIT", "NEO")],
    });
    const found = await searchTickerCandidates({ query: `ibit ${suffix}`, tickers: new Map(), dataProvider, totalLimit: 20 });
    expect(found[0]?.result).toMatchObject({ symbol: "IBIT", exchange: "NASDAQ" });
    expect(found.filter((item) => item.symbol === "IBIT").map((item) => item.exchangeLabel)).toEqual(["NASDAQ", "ASX", "NEO"]);
  });

  test.each([['spy', 'ARCA', 'YSPY'], ['QQQ', 'NASDAQ', 'TQQY'], ['QQQ', 'NASDAQ', 'QBIG']])(
    "loose %s ETF matches such as %s %s follow its exact listing", async (symbol, exchange, other) => {
      const dataProvider = createTestDataProvider({ search: async (query) => query.toLowerCase().endsWith(" etf")
        ? [makeSearchResult(other, `${symbol} ETF strategy`, { exchange: "NASDAQ", type: "ETF" })]
        : [makeSearchResult(symbol.toUpperCase(), `${symbol} fund`, { exchange, type: "ETF" })],
      });
      const found = await searchTickerCandidates({ query: `${symbol} ETF`, tickers: new Map(), dataProvider });
      expect(found[0]?.result).toMatchObject({ symbol: symbol.toUpperCase(), exchange });
    },
  );

  test("resolves catalogue omissions through a quote for the exact market symbol only", async () => {
    const lookalike = makeSearchResult("ESF", "Eurotech", { exchange: "MTA" });
    const quoteCalls: string[] = [];
    const dataProvider = createTestDataProvider({
      search: async () => [lookalike],
      getQuote: async (symbol) => {
        quoteCalls.push(symbol);
        return {
          symbol, providerId: "market-data", name: "S&P 500 Futures", price: 6000,
          currency: "USD", lastUpdated: Date.now(), change: 10, changePercent: 0.1,
          exchangeName: "CME",
        };
      },
    });
    const candidates = await searchTickerCandidates({ query: "ES=F", tickers: new Map(), dataProvider });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ symbol: "ES=F", instrumentClass: "derivative", result: { currency: "USD", exchange: "CME", type: "FUTURE" } });
    expect(quoteCalls).toEqual(["ES=F"]);

    for (const invalidQuote of [
      { symbol: "ESF", price: 6000 },
      { symbol: "ES=F", price: NaN },
      { symbol: "ES=F", price: 0 },
    ]) {
      expect(await resolveTickerSearch({
        query: "ES=F", activeTicker: null, tickers: new Map(),
        dataProvider: createTestDataProvider({
          search: async () => [lookalike],
          getQuote: async () => ({ ...invalidQuote, currency: "USD", lastUpdated: Date.now(), change: 0, changePercent: 0 }),
        }),
      })).toBeNull();
    }
  });

  test("a suffixed listing search does not carry resolves through its own quote, as quote reads it", async () => {
    const quote = (symbol: string, overrides: Record<string, unknown> = {}) => ({
      symbol, name: "CEZ, a. s.", listingExchangeName: "PSE", currency: "CZK", price: 1365, instrumentType: "EQUITY",
      lastUpdated: 1, change: 0, changePercent: 0, ...overrides,
    });
    const resolve = (query: string, answer: ReturnType<typeof quote>) => resolveTickerSearch({ query, activeTicker: null, tickers: new Map(),
      dataProvider: createTestDataProvider({ search: async () => [], getQuote: async () => answer }) });
    // The quote comes with it, so the add row does not ask for it again.
    expect(await resolve("CEZ.PR", quote("CEZ.PR"))).toMatchObject({
      kind: "provider", symbol: "CEZ.PR", result: { symbol: "CEZ.PR", exchange: "PSE", currency: "CZK", name: "CEZ, a. s.", type: "EQUITY" },
      quote: { symbol: "CEZ.PR", price: 1365 },
    });
    // The quote has to answer for that key, price it, and sit on a venue the suffix belongs to.
    expect(await resolve("CEZ.PR", quote("CEZ"))).toBeNull();
    expect(await resolve("CEZ.PR", quote("CEZ.PR", { price: 0 }))).toBeNull();
    expect(await resolve("OMV.VI", quote("OMV.VI", { listingExchangeName: "LSE" }))).toBeNull();
    // A bare symbol is search's to resolve; its quote is never read as a listing.
    expect(await resolve("CEZ", quote("CEZ"))).toBeNull();
  });

  test("a lookup search was too busy to answer is no miss: it says so, unless a saved ticker or the listing's own quote settles it", async () => {
    const busy = async (): Promise<InstrumentSearchResult[]> => { throw new ProviderBusyError(); };
    const resolve = (query: string, search: () => Promise<InstrumentSearchResult[]>, tickers = new Map<string, TickerRecord>()) => resolveTickerSearch({
      query, activeTicker: null, tickers,
      dataProvider: createTestDataProvider({ search, getQuote: async () => ({ symbol: "CEZ.PR", name: "CEZ, a. s.", listingExchangeName: "PSE",
        currency: "CZK", price: 1365, instrumentType: "EQUITY", lastUpdated: 1, change: 0, changePercent: 0 }) }),
    });
    await expect(resolve("SBLK", busy)).rejects.toBeInstanceOf(ProviderBusyError);
    // Only a search that answered with nothing is a miss.
    expect(await resolve("SBLK", async () => [])).toBeNull();
    const saved = createTestTicker("SBLK", "Star Bulk Carriers", { exchange: "NASDAQ" });
    expect(await resolve("SBLK", busy, new Map([["SBLK", saved]]))).toMatchObject({ kind: "local", ticker: saved });
    // The busy literal lookup does not cut the fallbacks short.
    expect(await resolve("CEZ.PR", busy)).toMatchObject({ kind: "provider", symbol: "CEZ.PR", result: { exchange: "PSE" } });
  });

  test("a suffixed listing whose quote never answers reads as unmatched, without waiting on it", async () => {
    jest.useFakeTimers();
    try {
      let asked!: () => void;
      const quoteAsked = new Promise<void>((resolve) => { asked = resolve; });
      const resolved = resolveTickerSearch({ query: "CEZ.PR", activeTicker: null, tickers: new Map(),
        dataProvider: createTestDataProvider({ search: async () => [], getQuote: () => { asked(); return new Promise(() => {}); } }) });
      await quoteAsked;
      jest.advanceTimersByTime(5_000);
      expect(await resolved).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("resolves explicit venues ahead of punctuation lookalikes and saved foreign listings", async () => {
    const tickers = new Map([["VOD", createTestTicker("VOD", "Vodafone ADR", { exchange: "NASDAQ" })]]);
    const dataProvider = makeDataProvider([
      makeSearchResult("VODL", "Vodafone", { exchange: "CBOE" }),
      makeSearchResult("VOD", "Vodacom", { exchange: "JSE" }),
      makeSearchResult("VOD", "Vodafone", { exchange: "LSE" }),
    ]);
    for (const query of ["VOD.L", "VOD:XLON"]) {
      const results = await searchTickerCandidates({ query, tickers, dataProvider });
      expect(results[0]).toMatchObject({ symbol: "VOD", exchangeLabel: "LSE" });
      expect(findExactTickerSearchMatch(results, query)?.exchangeLabel).toBe("LSE");
      expect(await resolveTickerSearch({ query, activeTicker: null, tickers, dataProvider }))
        .toMatchObject({ kind: "provider", result: { symbol: "VOD", exchange: "LSE" } });
    }
    expect(findExactTickerSearchMatch([{ label: "VODL", right: "CBOE" }], "VOD.L")).toBeNull();
  });

  test("respects provider suffixes in Europe and numeric Asian listings", async () => {
    for (const [query, symbol, exchange] of [
      ["SAP.DE", "SAP", "XETRA"], ["AIR.PA", "AIR", "PAR"],
      ["ASML.AS", "ASML", "AMS"], ["7203.T", "7203", "JPX"], ["0700.HK", "700", "HKG"],
    ]) {
      const results = await searchTickerCandidates({
        query: query!, tickers: new Map(),
        dataProvider: makeDataProvider([makeSearchResult(symbol!, "Issuer", { exchange: exchange! })]),
      });
      expect(findExactTickerSearchMatch(results, query!)?.symbol).toBe(symbol!);
    }
  });

  test("normalizes explicit and focused ticker inputs", () => {
    expect(normalizeTickerInput("AAPL", undefined)).toBe("AAPL");
    expect(normalizeTickerInput("AAPL", " msft ")).toBe("MSFT");
    expect(normalizeTickerInput(null, undefined)).toBeNull();
  });

  test("finds exact provider matches for direct ticker resolution", async () => {
    const tickers = new Map<string, TickerRecord>([["AAPL", createTestTicker("AAPL", "Apple")]]);
    const resolved = await resolveTickerSearch({
      query: "MSFT",
      activeTicker: null,
      tickers,
      dataProvider: makeDataProvider([
        makeSearchResult("MSFT", "Microsoft"),
        makeSearchResult("MSFTW", "Microsoft Warrants"),
      ]),
    });

    expect(resolved).toMatchObject({
      kind: "provider",
      symbol: "MSFT",
    });
  });

  test("a venue code after the dot resolves like the listing suffix once the literal symbol finds nothing", async () => {
    const queried: string[] = [];
    const dataProvider = createTestDataProvider({
      id: "test",
      search: async (query: string) => {
        queried.push(query);
        if (query === "TTALO.HE") return [makeSearchResult("TTALO", "Terveystalo Oyj", { exchange: "HEL", currency: "EUR" })];
        if (query === "ABC.LON") return [makeSearchResult("ABC.LON", "Literal Co")];
        return [];
      },
    });
    const resolve = (query: string) => resolveTickerSearch({ query, activeTicker: null, tickers: new Map(), dataProvider });

    for (const query of ["TTALO.HEL", "TTALO.XHEL"]) {
      expect(await resolve(query)).toMatchObject({ kind: "provider", symbol: "TTALO", result: { exchange: "HEL", currency: "EUR" } });
    }
    // A literal match wins; the rewrite is only a fallback.
    queried.length = 0;
    expect(await resolve("ABC.LON")).toMatchObject({ symbol: "ABC.LON" });
    expect(queried.filter((query) => query === "ABC.L" || query === "ABC:LON")).toEqual([]);
  });

  test("combines local and provider candidates without duplicate saved symbols", async () => {
    const tickers = new Map<string, TickerRecord>([["AAPL", createTestTicker("AAPL", "Apple")]]);
    const results = await searchTickerCandidates({
      query: "appl",
      tickers,
      dataProvider: makeDataProvider([
        makeSearchResult("AAPL", "Apple Inc"),
        makeSearchResult("APP", "AppLovin"),
      ]),
    });

    expect(results.map((item) => item.id)).toEqual(["goto:AAPL", "search:APP:NASDAQ:TEST"]);
    expect(findExactTickerSearchMatch(results, "AAPL")?.id).toBe("goto:AAPL");
  });

  test("uses provider metadata to keep stale saved tickers intuitive in search results", async () => {
    const tickers = new Map<string, TickerRecord>([["AAPL", createTestTicker("AAPL", "AAPL")]]);
    const results = await searchTickerCandidates({
      query: "apple",
      tickers,
      dataProvider: makeDataProvider([
        makeSearchResult("AAPL", "Apple Inc"),
        makeSearchResult("APLE", "Apple Hospitality REIT, Inc."),
      ]),
    });

    expect(results.map((item) => item.id)).toEqual(["goto:AAPL", "search:APLE:NASDAQ:TEST"]);
    expect(results[0]).toMatchObject({
      id: "goto:AAPL",
      detail: "Apple Inc",
      category: "Saved",
    });
    expect(findExactTickerSearchMatch(results, "AAPL")?.id).toBe("goto:AAPL");
  });

  test("enriches duplicate provider symbols from the saved listing's exchange", () => {
    const results = buildTickerSearchCandidates({
      query: "Apple NASDAQ",
      tickers: new Map<string, TickerRecord>([
        ["APC", createTestTicker("APC", "Apple Inc.", { exchange: "XETRA", assetCategory: "STK" })],
        ["AAPL", createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ", assetCategory: "STK" })],
      ]),
      providerResults: [
        makeSearchResult("APC", "Apple Inc.", { exchange: "XETRA" }),
        makeSearchResult("AAPL", "Apple Inc. CEDEAR", {
          exchange: "BYMA",
          primaryExchange: "BYMA",
          currency: "ARS",
        }),
        makeSearchResult("AAPL", "Apple Inc.", {
          exchange: "SMART",
          brokerContract: {
            brokerId: "test",
            symbol: "AAPL",
            exchange: "NASDAQ",
          },
        }),
      ],
    });

    expect(results[0]).toMatchObject({
      id: "goto:AAPL",
      right: "NASDAQ",
      exchangeLabel: "NASDAQ",
    });
  });

  test("does not apply a conflicting provider primary exchange to a saved listing", () => {
    const results = buildTickerSearchCandidates({
      query: "Apple BUE",
      tickers: new Map<string, TickerRecord>([[
        "AAPL",
        createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ", assetCategory: "STK" }),
      ]]),
      providerResults: [
        makeSearchResult("AAPL", "Apple Inc.", {
          exchange: "SMART",
          primaryExchange: "BUE",
        }),
        makeSearchResult("AAPLC.BA", "Apple Inc.", { exchange: "BUE" }),
      ],
    });

    expect(results.find((item) => item.id === "goto:AAPL")?.primaryExchangeLabel).toBeUndefined();
    expect(results.find((item) => item.kind === "search" && item.symbol === "AAPL")?.primaryExchangeLabel).toBe("BUE");
  });

  test("a saved listing keeps its own venue and type when only another venue's line matches", () => {
    const results = buildTickerSearchCandidates({
      query: "Microsoft",
      tickers: new Map([["MSFT", createTestTicker("MSFT", "Microsoft Corporation", { exchange: "NASDAQ", assetCategory: "STK" })]]),
      providerResults: [makeSearchResult("MSFT", "Microsoft Corporation", {
        exchange: "BYMA", primaryExchange: "BYMA", currency: "ARS", type: "Depositary Receipt",
      })],
    });
    const saved = results.find((item) => item.id === "goto:MSFT")!;
    // Selecting it must not bind the BYMA receipt, and the row must not say so.
    expect(saved.result).toBeUndefined();
    expect(saved).toMatchObject({ right: "NASDAQ", instrumentType: "STK" });
  });

  for (const savedSymbol of ["SHOP", "SHOP:XNAS"]) {
    test(`saved ${savedSymbol} deduplicates venue aliases while retaining the unsaved TSX listing`, () => {
      const results = buildTickerSearchCandidates({
        query: "Shopify",
        tickers: new Map([[savedSymbol, createTestTicker(savedSymbol, "Shopify Inc.", { exchange: "NASDAQ" })]]),
        providerResults: [
          makeSearchResult("SHOP", "Shopify Inc.", { exchange: "XNAS", currency: "USD" }),
          makeSearchResult("SHOP", "Shopify Inc.", { exchange: "NASDAQ", currency: "USD" }),
          makeSearchResult("SHOP", "Shopify Inc.", { exchange: "TSX", currency: "CAD" }),
          makeSearchResult("SHOP", "Shopify Inc.", { exchange: "SMART", primaryExchange: "XTSE", currency: "CAD" }),
        ],
      });
      expect(results).toHaveLength(2);
      expect(results.find((item) => item.kind === "ticker")?.id).toBe(`goto:${savedSymbol}`);
      const foreign = results.find((item) => item.kind === "search")!;
      expect(foreign.saved).toBe(false);
      expect(foreign.category).not.toBe("Saved");
      expect(foreign.result?.currency).toBe("CAD");
    });
  }

  test("a saved second listing keeps its venue's place among the issuer's listings", () => {
    const venues = ["NYSE", "XETRA", "XSTU", "FWB2", "VIE", "SWX", "MUNICH", "HANOVER", "BUD"];
    const results = buildTickerSearchCandidates({
      query: "SAP",
      tickers: new Map([
        ["SAP", createTestTicker("SAP", "SAP SE", { exchange: "NYSE", assetCategory: "EQUITY" })],
        ["SAP:XETR", createTestTicker("SAP:XETR", "SAP SE", { exchange: "XETRA", assetCategory: "Common Stock" })],
      ]),
      providerResults: venues.map((exchange) => makeSearchResult("SAP", "SAP SE", { exchange, type: "Common Stock" })),
    });

    expect(results.slice(0, 3).map((item) => [item.label, item.exchangeLabel, item.kind])).toEqual([
      ["SAP", "NYSE", "ticker"],
      ["SAP:XETR", "XETRA", "ticker"],
      ["SAP", "XSTU", "search"],
    ]);
  });

  test("uses provider ordering to prefer the canonical saved listing for company-name queries", () => {
    const tickers = new Map<string, TickerRecord>([
      ["APC", createTestTicker("APC", "Apple Inc.", {
        exchange: "XETRA",
        currency: "EUR",
        assetCategory: "STK",
      })],
      ["AAPL", createTestTicker("AAPL", "Apple Inc.", {
        exchange: "NASDAQ",
        currency: "USD",
        assetCategory: "STK",
      })],
    ]);

    const results = buildTickerSearchCandidates({
      query: "Apple",
      tickers,
      providerResults: [
        makeSearchResult("AAPL", "Apple Inc.", {
          exchange: "NASDAQ",
          primaryExchange: "NASDAQ",
          currency: "USD",
        }),
        makeSearchResult("APC", "Apple Inc.", {
          exchange: "XETRA",
          primaryExchange: "XETRA",
          currency: "EUR",
        }),
      ],
    });

    expect(results.slice(0, 2).map((item) => item.id)).toEqual([
      "goto:AAPL",
      "goto:APC",
    ]);
    expect(results.slice(0, 2).map((item) => item.category)).toEqual([
      "Saved",
      "Saved",
    ]);
  });

  test("keeps explicit symbol, exchange, and asset-class intent ahead of provider ordering", () => {
    const tickers = new Map<string, TickerRecord>([
      ["APC", createTestTicker("APC", "Apple Inc.", {
        exchange: "XETRA",
        currency: "EUR",
        assetCategory: "STK",
      })],
      ["AAPL", createTestTicker("AAPL", "Apple Inc.", {
        exchange: "NASDAQ",
        currency: "USD",
        assetCategory: "STK",
      })],
    ]);
    const providerResults = [
      makeSearchResult("AAPL", "Apple Inc.", { exchange: "NASDAQ" }),
      makeSearchResult("APC", "Apple Inc.", { exchange: "XETRA", currency: "EUR" }),
      makeSearchResult("APLY", "Yield Strategy Linked to Apple ETF", { exchange: "NYSE Arca", type: "ETF" }),
      makeSearchResult("APP", "AppLovin Corporation", { exchange: "NASDAQ" }),
    ];
    const firstSymbolFor = (query: string) => buildTickerSearchCandidates({
      query,
      tickers,
      providerResults,
    })[0]?.symbol;

    expect(firstSymbolFor("APC")).toBe("APC");
    expect(firstSymbolFor("APP")).toBe("APP");
    expect(firstSymbolFor("Apple XETRA")).toBe("APC");
    expect(firstSymbolFor("Apple NASDAQ")).toBe("AAPL");
    expect(firstSymbolFor("Apple ETF")).toBe("APLY");
  });

  test("uses provider ordering without assuming the canonical listing is on a US exchange", () => {
    const results = buildTickerSearchCandidates({
      query: "Toyota",
      tickers: new Map<string, TickerRecord>([[
        "TM",
        createTestTicker("TM", "Toyota Motor Corporation", {
          exchange: "NYSE",
          currency: "USD",
          assetCategory: "STK",
        }),
      ]]),
      providerResults: [
        makeSearchResult("7203", "Toyota Motor Corp", {
          exchange: "Tokyo Stock Exchange",
          primaryExchange: "Tokyo Stock Exchange",
          currency: "JPY",
        }),
        makeSearchResult("TM", "Toyota Motor Corporation", {
          exchange: "NYSE",
          primaryExchange: "NYSE",
          currency: "USD",
        }),
        makeSearchResult("TOYOTA80.BK", "TOYOTA80 DR", {
          exchange: "SET",
          currency: "THB",
        }),
      ],
    });

    expect(results.slice(0, 2).map((item) => [item.symbol, item.category])).toEqual([
      ["7203", "Primary Listing"],
      ["TM", "Saved"],
    ]);
  });

  test("does not let provider order or an accidental symbol prefix overwhelm a closer company match", () => {
    const results = buildTickerSearchCandidates({
      query: "Apple",
      tickers: new Map<string, TickerRecord>(),
      providerResults: [
        makeSearchResult("APLE", "Apple Hospitality REIT, Inc.", { exchange: "NYSE" }),
        makeSearchResult("AAPL", "Apple Inc.", { exchange: "NASDAQ" }),
        makeSearchResult("APPLE80.BK", "APPLE80 DR", { exchange: "SET", currency: "THB" }),
      ],
    });

    expect(results[0]?.symbol).toBe("AAPL");
    expect(results.some((item) => item.symbol === "APPLE80.BK")).toBe(true);
  });

  test("orders companies matched by name alone by provider popularity, not name length", () => {
    const rank = (query: string, providerResults: InstrumentSearchResult[]) => buildTickerSearchCandidates({
      query,
      tickers: new Map<string, TickerRecord>(),
      providerResults,
    }).map((item) => item.symbol);

    expect(rank("Siemens", [
      makeSearchResult("SIE", "Siemens Aktiengesellschaft", { exchange: "XETRA" }),
      makeSearchResult("SHL", "Siemens Healthineers AG", { exchange: "XETRA", type: "Common Stock" }),
    ])).toEqual(["SIE", "SHL"]);
    // Accented names stay whole words, so the unaccented query still matches them.
    expect(rank("nestle", [
      makeSearchResult("NESTLEIND", "Nestle India Ltd.", { exchange: "NSE" }),
      makeSearchResult("NESN", "Nestlé S.A.", { exchange: "SWX" }),
    ])).toEqual(["NESN", "NESTLEIND"]);
  });

  describe("trade-name aliases", () => {
    const build = (query: string, providerResults: InstrumentSearchResult[]) => buildTickerSearchCandidates({
      query,
      tickers: new Map<string, TickerRecord>(),
      providerResults,
      totalLimit: 10,
    }).map((item) => `${item.symbol}:${item.exchangeLabel}`);

    test("a row filed under a trade name matches it and leads; without the alias its legal name is dropped", () => {
      const home = makeSearchResult("2222", "Saudi Arabian Oil Co.", { exchange: "TADAWUL", type: "Common Stock" });
      const subsidiary = makeSearchResult("2223", "Saudi Aramco Base Oil Company", { exchange: "TADAWUL", type: "Common Stock" });
      expect(build("Aramco", [subsidiary, { ...home, searchAliases: ["Aramco", "Saudi Aramco"] }]))
        .toEqual(["2222:TADAWUL", "2223:TADAWUL"]);
      // Older servers send no aliases: only the namesake subsidiary matches.
      expect(build("Aramco", [subsidiary, home])).toEqual(["2223:TADAWUL"]);
    });

    test("rows sharing a trade name keep the server's order, ahead of lookalike names", () => {
      const alphabet = (symbol: string, share: string) => makeSearchResult(symbol, `Alphabet Inc. Class ${share} Common Stock`,
        { searchAliases: ["Google"] });
      const rows = [
        alphabet("GOOGL", "A"),
        alphabet("GOOG", "C"),
        makeSearchResult("GOOGL", "Google Inc.", { exchange: "BYMA", type: "Depositary Receipt" }),
      ];
      expect(build("Google", rows)).toEqual(["GOOGL:NASDAQ", "GOOG:NASDAQ", "GOOGL:BYMA"]);
    });
  });

  describe("a renamed company's old name", () => {
    const build = (query: string, providerResults: InstrumentSearchResult[]) => buildTickerSearchCandidates({
      query,
      tickers: new Map<string, TickerRecord>(),
      providerResults,
      totalLimit: 10,
    }).map((item) => `${item.symbol}:${item.category}`);
    // The service's answer to "cassava", 2026-10-25: the company's own line first, carrying the old name, then
    // the German lines that still list it so, and a namesake.
    const answer = [
      makeSearchResult("FLNA", "Filana Therapeutics, Inc.", { type: "Common Stock", currency: "USD", searchAliases: ["CASSAVA SCIENCES INC"] }),
      ...[["PX91.MU", "MUNICH", 20010], ["PX91.DU", "XDUS", 20005], ["PX91.SG", "XSTU", 20002], ["PX91.HM", "XHAM", 20001]]
        .map(([symbol, exchange, popularity]) => makeSearchResult(symbol as string, "Cassava Sciences Inc", { exchange: exchange as string, popularity: popularity as number })),
      makeSearchResult("0841", "Asia Cassava Resources Holdings Limited", { exchange: "HKEX", popularity: 20001 }),
    ];

    test("the company's own line leads, its old name matched, and the venues that still list the old name follow it", () => {
      expect(build("cassava", answer)).toEqual([
        "FLNA:Primary Listing", "PX91.MU:Other Listings", "PX91.DU:Other Listings", "PX91.SG:Other Listings", "PX91.HM:Other Listings",
        "0841:Other Listings",
      ]);
      expect(build("Cassava Sciences", answer).slice(0, 2)).toEqual(["FLNA:Primary Listing", "PX91.MU:Other Listings"]);
    });

    test("another company's name still leads its own query, and a row sent without the alias keeps its place", () => {
      expect(build("asia cassava", answer)[0]).toBe("0841:Primary Listing");
      const withoutAlias = answer.map(({ searchAliases: _aliases, ...row }) => row);
      expect(build("cassava", withoutAlias)[0]).toBe("PX91.MU:Primary Listing");
    });
  });

  describe("themes and several words", () => {
    const build = (query: string, providerResults: InstrumentSearchResult[]) => buildTickerSearchCandidates({
      query,
      tickers: new Map<string, TickerRecord>(),
      providerResults,
      totalLimit: 10,
    }).map((item) => `${item.symbol}:${item.category}`);
    const lithium = { searchKeywords: ["lithium"] };
    const rows = [
      makeSearchResult("LAC", "Lithium Americas Corp.", { exchange: "NYSE", type: "EQUITY" }),
      makeSearchResult("ALB", "Albemarle Corporation", { exchange: "NYSE", type: "EQUITY", ...lithium }),
      makeSearchResult("LIT", "Global X Lithium & Battery Tech ETF", { exchange: "ARCA", type: "ETF", ...lithium }),
      makeSearchResult("SQM", "Sociedad Química y Minera de Chile S.A.", { exchange: "NYSE", type: "EQUITY", ...lithium }),
      makeSearchResult("COPX", "Global X Copper Miners ETF", { exchange: "ARCA", type: "ETF" }),
    ];

    test("the companies sent with a theme follow its funds, as related, before the names; older servers' rows are dropped", () => {
      expect(build("lithium", rows)).toEqual([
        "LIT:Funds & Derivatives", "ALB:Related", "SQM:Related", "LAC:Primary Listing",
      ]);
      expect(build("lithium etf", rows)).toEqual(["LIT:Funds & Derivatives"]);
      expect(build("lithium", rows.map(({ searchKeywords: _keywords, ...row }) => row))).toEqual([
        "LAC:Primary Listing", "LIT:Funds & Derivatives",
      ]);
    });

    test("a sector word lists its funds, in the server's order, before the small companies named for it", async () => {
      // /market/search?q=defense and q=defense ETF, recorded 2026-10-11: the name search lists a TSXV explorer
      // and OTC names first and tags a few funds last; the ETF search lists the large ones by size.
      const defense = { searchKeywords: ["defense"] };
      const names = [
        makeSearchResult("DEFN", "Defense Metals Corp.", { exchange: "TSXV", type: "Common Stock" }),
        makeSearchResult("DTII", "Defense Technologies International Corp.", { exchange: "OTC", type: "Common Stock" }),
        makeSearchResult("KTOS", "Kratos Defense & Security Solutions, Inc.", { exchange: "NASDAQ", type: "Common Stock" }),
        makeSearchResult("PPA", "Invesco Aerospace & Defense ETF", { exchange: "ARCA", type: "ETF", ...defense }),
        makeSearchResult("LMT", "Lockheed Martin Corporation", { exchange: "NYSE", type: "EQUITY", ...defense }),
      ];
      const funds = [
        ...["ITA", "XAR", "PPA", "EUAD", "MISL", "NATO"].map((symbol) => makeSearchResult(symbol, `${symbol} Aerospace & Defense ETF`, { exchange: "ARCA", type: "ETF" })),
        makeSearchResult("512710", "FG CSI Aerospace & Defense ETF", { exchange: "SSE", type: "ETF" }),
        makeSearchResult("ITA", "iShares U.S. Aerospace & Defense ETF", { exchange: "BMV", type: "ETF" }),
      ];
      const calls: string[] = [];
      const dataProvider = createTestDataProvider({
        id: "test",
        // The server's search ignores case: "defense etf" is "defense ETF".
        search: async (query) => { calls.push(query); return query === "defense" ? names : query.toLowerCase() === "defense etf" ? funds : []; },
      });
      const listed = await searchTickerCandidates({ query: "defense", tickers: new Map(), dataProvider, totalLimit: 10 });
      // Five US-listed funds in the server's order lead, then the companies sent with the word; the sixth fund and other
      // venues' lines follow the names.
      expect(listed.slice(0, 8).map((item) => `${item.symbol}:${item.exchangeLabel}`)).toEqual([
        "ITA:ARCA", "XAR:ARCA", "PPA:ARCA", "EUAD:ARCA", "MISL:ARCA", "LMT:NYSE", "DEFN:TSXV", "DTII:OTC",
      ]);
      expect(calls.filter((call) => call.endsWith(" ETF"))).toEqual(["defense ETF"]);
      // "defense etf" asks for the funds by name: the name search alone holds only the tagged PPA, so the ETF search's
      // funds lead in its order, ITA first. The query asked whole is that search: asked once.
      calls.length = 0;
      const etfs = await searchTickerCandidates({ query: "defense etf", tickers: new Map(), dataProvider, totalLimit: 10 });
      expect(etfs.slice(0, 5).map((item) => `${item.symbol}:${item.exchangeLabel}`)).toEqual(["ITA:ARCA", "XAR:ARCA", "PPA:ARCA", "EUAD:ARCA", "MISL:ARCA"]);
      expect(calls.filter((call) => / etf$/i.test(call))).toEqual(["defense etf"]);
      // So does a phrase no symbol is; a word no row is tagged with is a name or a symbol: no second search.
      calls.length = 0;
      await searchTickerCandidates({ query: "aerospace defense etf", tickers: new Map(), dataProvider, totalLimit: 10 });
      expect(calls.filter((call) => / etf$/i.test(call))).toEqual(["aerospace defense etf"]);
      calls.length = 0;
      await searchTickerCandidates({ query: "kratos", tickers: new Map(), dataProvider, totalLimit: 10 });
      await searchTickerCandidates({ query: "kratos etf", tickers: new Map(), dataProvider, totalLimit: 10 });
      expect(calls.some((call) => call.endsWith(" ETF"))).toBe(false);
    });

    test("a sector's leaders the server tags make the first ten past the juniors named for it", async () => {
      // /market/search?q=lithium and q=lithium ETF, recorded 2026-10-16: the names first, the tagged rows last.
      const named = [["LAC", "Lithium Americas Corp.", "NYSE"], ["LAR", "Lithium Argentina AG", "NYSE"], ["LAC", "Lithium Americas Corp.", "TSX"],
        ["SLI", "Standard Lithium Ltd.", "AMEX"], ["ATLX", "Atlas Lithium Corporation", "NASDAQ"], ["SGML", "Sigma Lithium Corporation", "NASDAQ"]]
        .map(([symbol, name, exchange]) => makeSearchResult(symbol!, name!, { exchange, type: "EQUITY" }));
      const tagged = [["LIT", "Global X Lithium & Battery Tech ETF", "ARCA", "ETF"], ["BATT", "Amplify Lithium & Battery Technology ETF", "ARCA", "ETF"],
        ["ALB", "Albemarle Corporation", "NYSE", "EQUITY"], ["SQM", "Sociedad Química y Minera de Chile S.A.", "NYSE", "EQUITY"],
        ["PLS", "PLS Group Limited", "ASX", "EQUITY"], ["LTR", "Liontown Limited", "ASX", "EQUITY"]]
        .map(([symbol, name, exchange, type]) => makeSearchResult(symbol!, name!, { exchange, type, searchKeywords: ["lithium"] }));
      const future = makeSearchResult("LTH=F", "Lithium Hydroxide CIF CJK (Fast", { exchange: "CMX", type: "FUTURE" });
      const funds = ["ASX", "CXA"].map((exchange) => makeSearchResult("ACDC", "Global X Battery Tech & Lithium ETF", { exchange, type: "ETF" }));
      const dataProvider = createTestDataProvider({ id: "test", search: async (query) =>
        query === "lithium" ? [...named.slice(0, 3), future, ...named.slice(3), ...tagged] : query === "lithium ETF" ? [...funds, ...tagged.slice(0, 2)] : [] });
      const listed = await searchTickerCandidates({ query: "lithium", tickers: new Map(), dataProvider, totalLimit: 10 });
      expect(listed.slice(0, 6).map((item) => item.symbol)).toEqual(["LIT", "BATT", "ALB", "SQM", "PLS", "LTR"]);
    });

    test("an exact name or symbol still leads a sector word's funds", () => {
      const fund = makeSearchResult("TSLY", "YieldMax TSLA Option Income Strategy ETF", { exchange: "ARCA", type: "ETF", searchKeywords: ["tesla"] });
      expect(build("tesla", [fund, makeSearchResult("TSLA", "Tesla, Inc.", { searchKeywords: ["tesla"] })]))
        .toEqual(["TSLA:Primary Listing", "TSLY:Funds & Derivatives"]);
      const gold = makeSearchResult("GOLD", "Gold.com Inc.", { exchange: "NYSE", type: "Common Stock" });
      const physical = makeSearchResult("PHAU", "WisdomTree Physical Gold ETC", { exchange: "LSE", type: "ETF", searchKeywords: ["gold"] });
      expect(build("gold", [physical, gold])[0]).toBe("GOLD:Primary Listing");
    });

    test("several words match on all of them in any order, never on some", () => {
      expect(build("miners copper", rows)).toEqual(["COPX:Funds & Derivatives"]);
      expect(build("copper lithium", rows)).toEqual([]);
    });
  });

  describe("provider popularity", () => {
    // Cloud responses with recorded search scores on 2026-09-23.
    const listing = (symbol: string, name: string, exchange: string, popularity?: number, type = "EQUITY") =>
      makeSearchResult(symbol, name, { exchange, type, ...(popularity == null ? {} : { popularity }) });
    const build = (query: string, providerResults: InstrumentSearchResult[]) => buildTickerSearchCandidates({
      query,
      tickers: new Map<string, TickerRecord>(),
      providerResults,
      totalLimit: 10,
    });
    const symbols = (query: string, providerResults: InstrumentSearchResult[]) =>
      build(query, providerResults).map((item) => item.symbol);
    const primary = (query: string, providerResults: InstrumentSearchResult[]) =>
      build(query, providerResults).find((item) => item.category === "Primary Listing")?.symbol;
    const withoutPopularity = (results: InstrumentSearchResult[]) =>
      results.map(({ popularity: _popularity, ...result }) => result);

    const taiwan = [
      listing("TSM", "Taiwan Semiconductor Manufacturing Company Limited", "NYSE", 94661),
      listing("2330", "Taiwan Semiconductor Manufacturing Company Limited", "TWSE", 22037),
      listing("TSMC34", "Taiwan Semiconductor Manufacturing Co., Ltd.", "B3", 20945, "Depositary Receipt"),
      listing("5425", "Taiwan Semiconductor Co., Ltd.", "TWSE", 20052),
      listing("057782", "Fubon Warrant on Taiwan Semiconductor", "TWSE", undefined, "Warrant"),
    ];

    test("a far more popular company outranks a small namesake typed exactly", () => {
      expect(symbols("Taiwan Semiconductor", taiwan)).toEqual(["TSM", "2330", "TSMC34", "5425", "057782"]);
      expect(primary("Taiwan Semiconductor", taiwan)).toBe("TSM");
      // Older servers send no popularity, so the exact name still leads there.
      expect(primary("Taiwan Semiconductor", withoutPopularity(taiwan))).toBe("5425");
    });

    test("comparable popularity keeps the exactly named company first", () => {
      const siemens = [
        listing("ENR", "Siemens Energy AG", "XETRA", 21317),
        listing("SIE", "Siemens Aktiengesellschaft", "XETRA", 20993),
        listing("SIEGY", "Siemens Aktiengesellschaft", "PNK", 20451),
        listing("SMERY", "Siemens Energy AG", "OQX", 20257),
        listing("SHL", "Siemens Healthineers AG", "XETRA", 20245),
      ];
      expect(symbols("Siemens", siemens)).toEqual(["SIE", "SIEGY", "ENR", "SMERY", "SHL"]);

      const nestle = [
        listing("NESN", "Nestlé S.A.", "SIX", 21186),
        listing("NSRGY", "Nestlé S.A.", "OID", 20886),
        listing("NESTLEIND", "Nestlé India Limited", "NSE", 20247),
      ];
      expect(symbols("nestle", nestle)).toEqual(["NESN", "NSRGY", "NESTLEIND"]);

      const apple = [
        listing("AAPL", "Apple Inc.", "NASDAQ", 235768),
        listing("APLE", "Apple Hospitality REIT, Inc.", "NYSE", 21233),
      ];
      for (const results of [apple, [...apple].reverse(), withoutPopularity([...apple].reverse())]) {
        expect(symbols("Apple", results)).toEqual(["AAPL", "APLE"]);
      }
    });

    test("a line of another business its name is in never takes the lead from the company's own line", () => {
      // Sony Financial Group trades in Tokyo beside Sony Group, so it is another business; its search score
      // took the lead from Sony Group's unscored home line.
      const sony = [
        listing("SONY", "Sony Group Corporation ADR", "NYSE", undefined, "American Depositary Receipt"),
        listing("8729", "Sony Financial Group Inc.", "JPX", 20053),
        listing("6758", "Sony Group Corp.", "JPX"),
      ];
      expect(primary("Sony Group", sony)).toBe("6758");
      // Siemens Energy beside Siemens AG on XETRA, searched twice as often.
      const siemens = [listing("SIE", "Siemens AG", "XETRA"), listing("ENR", "Siemens Energy AG", "XETRA", 42000), listing("ENR", "Siemens Energy AG", "VIE")];
      expect(primary("Siemens AG", siemens)).toBe("SIE");
      // A fuller name on no venue the company's own name trades on is still the company: Deutsche Lufthansa for LUFTHANSA.
      const lufthansa = [listing("LUFTH", "LUFTHANSA", "BUD"), listing("LHA", "Deutsche Lufthansa AG", "XETRA", 20933)];
      expect(primary("lufthansa", lufthansa)).toBe("LHA");
    });

    test("the row the service marks with the word is the company it means, ahead of a line abroad whose symbol is the word", () => {
      // /market/search?q=siemens on 2026-10-29: SIEMENS is Siemens Ltd. in India; the service marks SIE with "siemens".
      const home = (result: InstrumentSearchResult) => ({ ...result, homeListing: true });
      const siemens = [
        home(listing("SIEMENS", "Siemens Ltd.", "NSE")),
        home({ ...listing("SIE", "Siemens Aktiengesellschaft", "XETRA", 21467), searchAliases: ["siemens"] }),
        home(listing("ENR", "Siemens Energy AG", "XETRA", 24343)),
      ];
      expect(primary("siemens", siemens)).toBe("SIE");
      // Unmarked, the symbol keeps its lead.
      expect(primary("siemens", siemens.map(({ searchAliases: _aliases, ...result }) => result))).toBe("SIEMENS");
    });

    test("a typed depositary receipt yields to its issuer's home listing; an untyped ADR keeps popularity order", () => {
      const toyota = [
        listing("TM", "Toyota Motor Corporation", "NYSE", 23125),
        listing("7203", "Toyota Motor Corporation", "JPX", 20228),
        listing("TOYOF", "Toyota Motor Corporation", "PNK", 20069),
        listing("8015", "Toyota Tsusho Corporation", "JPX", 20033),
        listing("TOM", "Toyota Motor Corp.", "XHAN"),
      ];
      // The catalogue files TM as plain NYSE equity, exactly like a second home line.
      expect(symbols("Toyota", toyota)).toEqual(["TM", "7203", "TOYOF", "TOM", "8015"]);
      const typed = toyota.map((result) => result.symbol === "TM" ? { ...result, type: "Depositary Receipt" } : result);
      expect(symbols("Toyota", typed)).toEqual(["7203", "TOYOF", "TOM", "TM", "8015"]);
      expect(primary("Toyota", typed)).toBe("7203");
      // The receipt's own ticker lists the company's own shares first when the answer holds them, the receipt under them.
      expect(symbols("TM", typed).slice(0, 2)).toEqual(["7203", "TM"]);
      expect(symbols("TM", typed.filter((result) => result.exchange !== "JPX"))[0]).toBe("TM");
    });

    test("the line the service marks as the company's home leads its receipts, whatever matched the query", () => {
      const home = (result: InstrumentSearchResult) => ({ ...result, homeListing: true });
      // An untyped receipt the provider ranks first.
      const toyota = [
        listing("TM", "Toyota Motor Corporation", "NYSE", 25280),
        home(listing("7203", "Toyota Motor Corporation", "JPX", 20489)),
        listing("8015", "Toyota Tsusho Corporation", "JPX", 20033),
      ];
      expect(symbols("Toyota", toyota)).toEqual(["7203", "TM", "8015"]);
      expect(symbols("Taiwan Semiconductor", taiwan.map((result) => result.symbol === "2330" ? home(result) : result))[0]).toBe("2330");
      // "Sony" is the receipts' ticker; the home line of the same company, not Sony Financial's, takes the lead.
      const sony = [
        listing("SONY", "Sony Group Corporation ADR", "NYSE", 13830500, "American Depositary Receipt"),
        listing("SONY", "Sony Group Corporation", "NEO", undefined, "Depositary Receipt"),
        home(listing("8729", "Sony Financial Group Inc.", "JPX", 20053)),
        home(listing("6758", "Sony Group Corp.", "JPX", 20772)),
      ];
      expect(symbols("Sony", sony).slice(0, 3)).toEqual(["6758", "SONY", "SONY"]);
      // A venue named asks for that line.
      expect(symbols("SONY:NYSE", sony)[0]).toBe("SONY");
      // Without the mark (older servers), a receipt in the lead gives way to the company's own shares.
      const lvmh = [
        listing("LVMH", "LVMH Moët Hennessy Louis Vuitton, Société Européenne – Depositary Receipt (underlying: LVMH Moët Hennessy Louis Vuitton SE, Euronext Paris)", "TSX", undefined, "Depositary Receipt"),
        listing("MC", "LVMH Moët Hennessy Louis Vuitton SE", "EPA", 23408, "Common Stock"),
        listing("4MC", "LVMH", "BIT", undefined, "Common Stock"),
      ];
      expect(primary("LVMH", lvmh)).toBe("MC");
      expect(symbols("LVMH", lvmh).slice(0, 2)).toEqual(["MC", "LVMH"]);
    });

    test("a symbol's home listing leads another company's German regional line of it", () => {
      // /market/search?q=YAR on 2026-10-30: Americold's lines in Germany came first, Yara's home line on Oslo seventh.
      const yar = [
        listing("YAR", "Americold Realty Trust, Inc.", "MUNICH", undefined, "REIT"),
        listing("YAR", "Americold Realty Trust, Inc.", "FWB2", undefined, "REIT"),
        listing("YAR", "Americold Realty Trust Inc.", "HANOVER", undefined, "Common Stock"),
        listing("YAR", "Yari Minerals Limited", "ASX", undefined, "Common Stock"),
        { ...listing("YAR", "Yara International ASA", "OSL", undefined, "Common Stock"), homeListing: true },
      ];
      const ranked = build("YAR", yar);
      expect(ranked.find((item) => item.category === "Primary Listing")?.result?.exchange).toBe("OSL");
      // A home line of its own leads only a regional line: a symbol's line on its home exchange keeps the lead.
      const yari = [yar[3]!, yar[4]!];
      expect(build("YAR", yari)[0]?.result?.exchange).toBe("ASX");
    });
  });

  test("normalizes legal suffixes in literal company-name queries", () => {
    const cases = [
      {
        query: "Apple Inc",
        canonical: makeSearchResult("AAPL", "Apple Inc.", { exchange: "NASDAQ" }),
        alternate: makeSearchResult("AAPL-ADR", "Apple Inc. ADR", { exchange: "OTC" }),
      },
      {
        query: "Toyota Motor Corporation",
        canonical: makeSearchResult("TM", "Toyota Motor Corporation", { exchange: "NYSE" }),
        alternate: makeSearchResult("TM-ADR", "Toyota Motor Corporation ADR", { exchange: "OTC" }),
      },
    ];

    for (const { query, canonical, alternate } of cases) {
      const results = buildTickerSearchCandidates({
        query,
        tickers: new Map<string, TickerRecord>(),
        providerResults: [alternate, canonical],
      });

      expect(results[0]?.symbol).toBe(canonical.symbol);
    }
  });

  test("keeps same-issuer provider ordering transitive across ambiguous company matches", () => {
    const candidates = [
      {
        id: "big-apple-primary",
        label: "ZZZ",
        symbol: "ZZZ",
        detail: "Big Apple",
        right: "NYSE",
        category: "Other Listings",
        kind: "search" as const,
        instrumentClass: "equity" as const,
        providerRank: 1,
      },
      {
        id: "big-apple-alternate",
        label: "APPLEB",
        symbol: "APPLEB",
        detail: "Big Apple",
        right: "NASDAQ",
        category: "Other Listings",
        kind: "search" as const,
        instrumentClass: "equity" as const,
        providerRank: 2,
      },
      {
        id: "unrelated-apple",
        label: "XAPL",
        symbol: "XAPL",
        detail: "X Apple",
        right: "NYSE",
        category: "Other Listings",
        kind: "search" as const,
        instrumentClass: "equity" as const,
        providerRank: 0,
      },
    ];

    const expected = ["ZZZ", "APPLEB", "XAPL"];
    expect(rankTickerSearchItems(candidates, "Apple").map((item) => item.symbol)).toEqual(expected);
    expect(rankTickerSearchItems([...candidates].reverse(), "Apple").map((item) => item.symbol)).toEqual(expected);
  });

  test("ranks the primary listing above leveraged and depositary look-alikes", () => {
    const make = (symbol: string, right: string, providerRank: number) => ({
      id: symbol,
      label: symbol,
      symbol,
      detail: "NVIDIA Corporation",
      right,
      category: "Other Listings",
      kind: "search" as const,
      instrumentClass: "equity" as const,
      providerRank,
    });
    // Provider order puts the Milan 4x product first; every text signal ties.
    const candidates = [make("4NVDA", "MTA", 0), make("NVDA", "NASDAQ", 1), make("NVDC34", "BOVESPA", 2)];

    expect(rankTickerSearchItems(candidates, "nvidia").map((item) => item.symbol))
      .toEqual(["NVDA", "4NVDA", "NVDC34"]);

    // All-digit symbols are Tokyo, Shanghai and Hong Kong primaries, not look-alikes.
    const toyota = [
      { ...make("7203", "TSE", 0), detail: "Toyota Motor Corporation" },
      { ...make("TM", "NYSE", 1), detail: "Toyota Motor Corporation" },
    ];
    expect(rankTickerSearchItems(toyota, "toyota").map((item) => item.symbol)).toEqual(["7203", "TM"]);
  });

  test("normalizes punctuated legal suffixes before applying same-issuer provider order", () => {
    const results = buildTickerSearchCandidates({
      query: "Acme",
      tickers: new Map<string, TickerRecord>(),
      providerResults: [
        makeSearchResult("AMS.MC", "Acme S.A.", { exchange: "BME" }),
        makeSearchResult("ACM", "Acme SA", { exchange: "NYSE" }),
      ],
    });

    expect(results.slice(0, 2).map((item) => item.symbol)).toEqual(["AMS.MC", "ACM"]);
  });

  test("keeps saved funds in the saved category", () => {
    const results = buildTickerSearchCandidates({
      query: "Vanguard",
      tickers: new Map<string, TickerRecord>([[
        "VTI",
        createTestTicker("VTI", "Vanguard Total Stock Market ETF", {
          exchange: "NYSE Arca",
          assetCategory: "ETF",
        }),
      ]]),
      providerResults: [],
    });

    expect(results[0]).toMatchObject({ symbol: "VTI", category: "Saved" });
  });

  test("preserves exchange-qualified symbols and groups provider listings intuitively", () => {
    const results = buildTickerSearchCandidates({
      query: "apple",
      tickers: new Map<string, TickerRecord>(),
      providerResults: [
        makeSearchResult("AAPL", "Apple Inc"),
        { ...makeSearchResult("AAPL.BA", "Apple Inc"), exchange: "Buenos Aires" },
        { ...makeSearchResult("APLY.NE", "Apple Yield Shares Purpose ETF"), exchange: "NEO", type: "ETF" },
      ],
      localLimit: 6,
      totalLimit: 8,
    });

    expect(results.map((item) => [item.label, item.category])).toEqual([
      ["AAPL", "Primary Listing"],
      ["AAPL.BA", "Other Listings"],
      ["APLY.NE", "Funds & Derivatives"],
    ]);
  });

  test("finds exact symbol aliases for dotted share classes", () => {
    const match = findExactTickerSearchMatch([
      {
        id: "search:BRK.B",
        label: "BRK.B",
        detail: "Berkshire Hathaway Inc. Class B",
        kind: "search",
        category: "Primary Listing",
        searchAliases: ["BRK.B", "BRK B", "BRKB"],
      },
    ], "brkb");

    expect(match?.id).toBe("search:BRK.B");
  });

  test("expands compact share-class queries when searching providers", async () => {
    const queries: string[] = [];
    const expandedResults = await searchTickerCandidates({
      query: "brkb",
      tickers: new Map<string, TickerRecord>(),
      dataProvider: createTestDataProvider({
        id: "test",
        search: async (query) => {
          queries.push(query);
          return query.toLowerCase() === "brk-b"
            ? [{ providerId: "test", symbol: "BRK-B", name: "Berkshire Hathaway Inc. Class B", exchange: "NYSE", type: "EQUITY" }]
            : [];
        },
      }),
      totalLimit: 5,
    });

    expect(queries).toContain("BRK-B");
    expect(expandedResults[0]).toMatchObject({
      label: "BRK-B",
      category: "Primary Listing",
    });
  });

  test("tries canonical symbol aliases before raw lowercase provider searches", async () => {
    const queries: string[] = [];
    const results = await searchTickerCandidates({
      query: "nvda",
      tickers: new Map<string, TickerRecord>(),
      dataProvider: createTestDataProvider({
        id: "test",
        search: async (query) => {
          queries.push(query);
          return query === "NVDA"
            ? [makeSearchResult("NVDA", "NVIDIA Corporation")]
            : [{ ...makeSearchResult("NVD", "GraniteShares 2x Short NVDA Daily ETF"), exchange: "NYSEArca", type: "ETF" }];
        },
      }),
      totalLimit: 5,
      includeOptionContracts: false,
    });

    expect(queries[0]).toBe("NVDA");
    expect(results[0]).toMatchObject({
      label: "NVDA",
      category: "Primary Listing",
    });
  });

  test("upserts ticker records from provider search results", async () => {
    const saved: TickerRecord[] = [];
    const repository = {
      loadTicker: async () => null,
      createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
      saveTicker: async (ticker: TickerRecord) => {
        saved.push(ticker);
      },
    };

    const { ticker, created } = await upsertTickerFromSearchResult(repository as any, {
      providerId: "test",
      symbol: "NVDA",
      name: "NVIDIA",
      exchange: "NASDAQ",
      type: "EQUITY",
      currency: "USD",
    });

    expect(created).toBe(true);
    expect(ticker.metadata.ticker).toBe("NVDA");
    expect(saved).toHaveLength(0);
  });

  test("a listing searched without a currency is saved without one, so its position takes the portfolio's", async () => {
    const repository = {
      loadTicker: async () => null,
      createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
      saveTicker: async () => {},
    };
    const { ticker } = await upsertTickerFromSearchResult(repository as any, makeSearchResult("SAP", "SAP SE", { exchange: "XETRA" }));

    expect(ticker.metadata.currency).toBe("");
    const portfolio = { id: "main", name: "Main", currency: "EUR" };
    expect(resolveManualPositionCurrency(undefined, ticker, portfolio, "USD")).toBe("EUR");
  });

  test("a crypto exchange's line of a coin pair is saved as the crypto venue's listing, in the pair's currency", async () => {
    // Search offered these lines without a currency; no source quotes them, and the row read as dollars.
    const picks = [
      ["BTC/GBP", "COINBASE PRO", "BTC-GBP", "GBP"],
      ["DOGE/GBP", "KRAKEN", "DOGE-GBP", "GBP"],
      ["ETH/EUR", "KRAKEN", "ETH-EUR", "EUR"],
      ["LINK/EUR", "BINANCE", "LINK-EUR", "EUR"],
      ["LINK/ETH", "UPBIT", "LINK-ETH", "ETH"],
    ] as const;
    for (const [symbol, exchange, listing, currency] of picks) {
      for (const tickerSymbol of [undefined, `${symbol}:${exchange}`]) {
        const loaded: string[] = [];
        const repository = {
          loadTicker: async (key: string) => { loaded.push(key); return null; },
          createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
          saveTicker: async () => {},
        };
        const pick = makeSearchResult(symbol, `${symbol} pair`, { exchange, type: "Digital Currency", currency: "" });
        const { ticker } = await upsertTickerFromSearchResult(repository as any, pick, { tickerSymbol });
        expect(ticker.metadata, `${symbol} ${tickerSymbol ?? ""}`).toMatchObject({ exchange: "CCC", currency });
        expect(parsePublicTickerKey(ticker.metadata.ticker).symbol).toBe(listing);
        expect(loaded.some((key) => key.includes("/"))).toBe(false);
      }
    }
    // The venue's own row names its currency too; a share class on a stock exchange is not a coin.
    const repository = { loadTicker: async () => null, createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }), saveTicker: async () => {} };
    expect((await upsertTickerFromSearchResult(repository as any, makeSearchResult("BTC-GBP", "Bitcoin GBP", { exchange: "CCC" }))).ticker.metadata)
      .toMatchObject({ ticker: "BTC-GBP", exchange: "CCC", currency: "GBP" });
    expect((await upsertTickerFromSearchResult(repository as any, makeSearchResult("BRK/B", "Berkshire", { exchange: "NYSE" }))).ticker.metadata)
      .toMatchObject({ ticker: "BRK/B", exchange: "NYSE", currency: "" });
  });

  test("a coin pair typed with a slash resolves to the crypto venue's listing", async () => {
    const searched: string[] = [];
    const dataProvider = createTestDataProvider({
      search: async (query: string) => {
        searched.push(query);
        return query === "BTC-GBP" ? [makeSearchResult("BTC-GBP", "Bitcoin GBP", { exchange: "CCC", type: "CRYPTOCURRENCY" })] : [];
      },
    });
    for (const query of ["btc/gbp", "BTC/GBP:KRAKEN"]) {
      expect(await resolveTickerSearch({ query, activeTicker: null, tickers: new Map(), dataProvider }))
        .toMatchObject({ kind: "provider", symbol: "BTC-GBP", result: { exchange: "CCC" } });
    }
    expect(searched[0]).toBe("BTC-GBP");
    expect(searched.some((query) => query.includes("/"))).toBe(false);
    // Typed in the search bar, BTC/GBP looks like a currency pair's spelling, which keeps only market symbols.
    const rows = [makeSearchResult("BTC-GBP", "Bitcoin GBP", { exchange: "CCC", type: "CRYPTOCURRENCY" }),
      makeSearchResult("EURUSD=X", "EUR/USD", { exchange: "CCY", type: "CURRENCY" })];
    expect(buildTickerSearchCandidates({ query: "btc/gbp", tickers: new Map(), providerResults: rows }).map((item) => item.symbol)).toEqual(["BTC-GBP"]);
    expect(buildTickerSearchCandidates({ query: "EUR/USD", tickers: new Map(), providerResults: rows }).map((item) => item.symbol)).toEqual(["EURUSD=X"]);
  });

  test("a spot commodity or a currency typed or picked with a slash is never read as a coin", async () => {
    // GAU-USD is a token (Gamer Arena); GAU/USD is gold by the gram, WTI/USD and XBR/USD spot crude.
    const searched: string[] = [];
    const spot = (symbol: string, exchange: string) => makeSearchResult(symbol, symbol, { exchange, type: exchange === "CCY" ? "CURRENCY" : "COMMODITY" });
    const rows: Record<string, ReturnType<typeof spot>[]> = {
      "WTI/USD": [spot("WTI/USD", "COMMODITY")], "GAU/USD:COMMODITY": [spot("GAU/USD", "COMMODITY")],
      "XBR/USD": [spot("XBR/USD", "COMMODITY")], "RUBUSD=X": [spot("RUBUSD=X", "CCY")],
    };
    const dataProvider = createTestDataProvider({
      search: async (query: string) => { searched.push(query); return rows[query] ?? []; },
    });
    for (const [query, symbol, exchange] of [["wti/usd", "WTI/USD", "COMMODITY"], ["GAU/USD:COMMODITY", "GAU/USD", "COMMODITY"],
      ["xbr/usd", "XBR/USD", "COMMODITY"], ["RUB/USD:CCY", "RUBUSD=X", "CCY"]] as const) {
      expect(await resolveTickerSearch({ query, activeTicker: null, tickers: new Map(), dataProvider }), query)
        .toMatchObject({ kind: "provider", symbol, result: { exchange } });
    }
    expect(searched.filter((query) => query.includes("-"))).toEqual([]);
    // A pick of one is saved as it is.
    const repository = { loadTicker: async () => null, createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }), saveTicker: async () => {} };
    for (const [symbol, exchange] of [["GAU/USD", "COMMODITY"], ["WTI/USD", "COMMODITY"], ["RUB/USD", "CCY"]] as const) {
      const pick = makeSearchResult(symbol, symbol, { exchange, type: "Digital Currency" });
      expect((await upsertTickerFromSearchResult(repository as any, pick)).ticker.metadata.exchange, symbol).toBe(exchange);
    }
  });

  test("refreshes low-quality saved metadata when opening a provider-backed result", async () => {
    const existing = createTestTicker("AAPL", "AAPL");
    const saved: TickerRecord[] = [];
    const repository = {
      loadTicker: async () => existing,
      createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
      saveTicker: async (ticker: TickerRecord) => {
        saved.push(ticker);
      },
    };

    const { ticker, created } = await upsertTickerFromSearchResult(repository as any, {
      providerId: "test",
      symbol: "AAPL",
      name: "Apple Inc.",
      exchange: "NASDAQ",
      type: "EQUITY",
      currency: "USD",
    });

    expect(created).toBe(false);
    expect(ticker.metadata.name).toBe("Apple Inc.");
    expect(saved).toHaveLength(1);
  });

  test("keeps holdings intact when opening a second listing with the same symbol", async () => {
    const existing = createTestTicker("AAPL", "Apple Inc.");
    existing.metadata.exchange = "NASDAQ";
    existing.metadata.currency = "USD";
    existing.metadata.portfolios = ["Core"];
    existing.metadata.positions = [{ portfolio: "Core", quantity: 10, costBasis: 200, currency: "USD" }] as any;
    const original = structuredClone(existing);
    const records = new Map([["AAPL", existing]]);
    const saved: TickerRecord[] = [];
    const repository = {
      loadTicker: async (symbol: string) => records.get(symbol) ?? null,
      createTicker: async (metadata: TickerRecord["metadata"]) => {
        const ticker = { metadata };
        records.set(metadata.ticker, ticker);
        return ticker;
      },
      saveTicker: async (ticker: TickerRecord) => {
        saved.push(ticker);
      },
    };

    const result: InstrumentSearchResult = {
      providerId: "test",
      symbol: "AAPL",
      name: "Apple Inc.",
      exchange: "BYMA",
      type: "EQUITY",
      currency: "ARS",
    };
    const { ticker, created } = await upsertTickerFromSearchResult(repository as any, result);

    expect(created).toBe(true);
    expect(ticker.metadata.ticker).toBe("AAPL:BYMA");
    expect(ticker.metadata.exchange).toBe("BYMA");
    expect(ticker.metadata.currency).toBe("ARS");
    expect(ticker.metadata.positions).toEqual([]);
    expect(existing).toEqual(original);
    expect(saved).toHaveLength(0);
    expect(await upsertTickerFromSearchResult(repository as any, result)).toMatchObject({ created: false, ticker });
  });

  test("exposes local ticker candidates in saved category", () => {
    expect(createLocalTickerSearchCandidates([createTestTicker("TSLA", "Tesla")])).toEqual([
      expect.objectContaining({
        id: "goto:TSLA",
        label: "TSLA",
        category: "Saved",
        kind: "ticker",
      }),
    ]);
  });
});
