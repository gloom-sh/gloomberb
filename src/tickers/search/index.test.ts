import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../types/data-provider";
import type { InstrumentSearchResult } from "../../types/instrument";
import type { TickerRecord } from "../../types/ticker";
import { createTestDataProvider } from "../../test-support/data-provider";
import { loadYahooQuote } from "../../sources/yahoo-finance/snapshots";
import {
  AmbiguousTickerError,
  buildTickerSearchCandidates,
  createLocalTickerSearchCandidates,
  findExactTickerSearchMatch,
  normalizeTickerInput,
  rankTickerSearchItems,
  resolveTickerSearch,
  searchTickerCandidates,
  upsertTickerFromSearchResult,
} from "./index";

function makeTicker(
  symbol: string,
  name = symbol,
  overrides: Partial<TickerRecord["metadata"]> = {},
): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
      ...overrides,
    },
  };
}

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
    const saved = makeTicker("VOD", "Saved Vodafone", { exchange: "LSE", currency: "GBP" });
    expect(await resolveTickerSearch({ query: "VOD", activeTicker: null, tickers: new Map([["VOD", saved]]), dataProvider }))
      .toMatchObject({ kind: "local", ticker: saved });
    expect(quoteCalls).toBe(0);
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
    const savedAlias = makeTicker("SHIB/USD", "SHIBA INU US Dollar", { exchange: "COINBASE PRO", assetCategory: "Digital Currency" });
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

  test("native Yahoo chart instrument type verifies an omitted crypto catalogue entry", async () => {
    const dataProvider = createTestDataProvider({
      search: async () => [makeSearchResult("SHIB/USD", "Shiba Inu", { exchange: "COINBASE PRO", type: "Digital Currency" })],
      getQuote: async (symbol) => loadYahooQuote(symbol, {
        providerId: "yahoo-finance",
        fetchChart: async () => ({ meta: { instrumentType: "CRYPTOCURRENCY", currency: "USD", exchangeName: "CCC",
          regularMarketPrice: 0.00000509, regularMarketTime: 1789077420 }, history: [{ date: new Date("2026-09-10"), close: 0.00000509 }] }),
        fetchQuoteSupplement: async () => ({}), fetchExtendedHoursData: async () => ({}),
      }),
    });
    expect(await resolveTickerSearch({ query: "SHIB-USD", activeTicker: null, tickers: new Map(), dataProvider }))
      .toMatchObject({ symbol: "SHIB-USD", result: { type: "CRYPTOCURRENCY", exchange: "CCC" } });
  });

  test("preserves futures, FX and index identity across saved and provider search matches", async () => {
    for (const symbol of ["ES=F", "6J=F", "JPY=X", "EURUSD=X", "EUR/USD", "^GSPC"]) {
      const lookalike = symbol.replace(/[^A-Z0-9]/g, "");
      const tickers = new Map([[lookalike, makeTicker(lookalike)]]);
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

  test("retains the quote currency of FX catalogue rows and reuses saved qualified futures", async () => {
    for (const symbol of ["JPY=X", "USDJPY=X", "USD/JPY", "EUR/JPY"]) {
      expect(await resolveTickerSearch({
        query: symbol, activeTicker: null, tickers: new Map(),
        dataProvider: makeDataProvider([makeSearchResult(symbol, "Currency Pair", { type: "Physical Currency" })]),
      })).toMatchObject({ kind: "provider", result: { symbol, currency: "JPY" } });
    }
    const future = makeTicker("ES=F:CME", "S&P 500 Futures", { exchange: "CME", assetCategory: "FUTURE" });
    for (const query of ["ES=F", "ES=F:CME"]) {
      expect(await resolveTickerSearch({
        query, activeTicker: null, tickers: new Map([[future.metadata.ticker, future]]),
        dataProvider: createTestDataProvider({ search: async () => { throw new Error("saved future should resolve locally"); } }),
      })).toMatchObject({ kind: "local", symbol: "ES=F:CME" });
    }
    expect(findExactTickerSearchMatch([{ label: "ES=F:CME" }], "ES=F:NYMEX")).toBeNull();
  });

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

  test("resolves explicit venues ahead of punctuation lookalikes and saved foreign listings", async () => {
    const tickers = new Map([["VOD", makeTicker("VOD", "Vodafone ADR", { exchange: "NASDAQ" })]]);
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
    const tickers = new Map<string, TickerRecord>([["AAPL", makeTicker("AAPL", "Apple")]]);
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

  test("combines local and provider candidates without duplicate saved symbols", async () => {
    const tickers = new Map<string, TickerRecord>([["AAPL", makeTicker("AAPL", "Apple")]]);
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
    const tickers = new Map<string, TickerRecord>([["AAPL", makeTicker("AAPL", "AAPL")]]);
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
        ["APC", makeTicker("APC", "Apple Inc.", { exchange: "XETRA", assetCategory: "STK" })],
        ["AAPL", makeTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ", assetCategory: "STK" })],
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
        makeTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ", assetCategory: "STK" }),
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

  for (const savedSymbol of ["SHOP", "SHOP:XNAS"]) {
    test(`saved ${savedSymbol} deduplicates venue aliases while retaining the unsaved TSX listing`, () => {
      const results = buildTickerSearchCandidates({
        query: "Shopify",
        tickers: new Map([[savedSymbol, makeTicker(savedSymbol, "Shopify Inc.", { exchange: "NASDAQ" })]]),
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

  test("uses provider ordering to prefer the canonical saved listing for company-name queries", () => {
    const tickers = new Map<string, TickerRecord>([
      ["APC", makeTicker("APC", "Apple Inc.", {
        exchange: "XETRA",
        currency: "EUR",
        assetCategory: "STK",
      })],
      ["AAPL", makeTicker("AAPL", "Apple Inc.", {
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
      ["APC", makeTicker("APC", "Apple Inc.", {
        exchange: "XETRA",
        currency: "EUR",
        assetCategory: "STK",
      })],
      ["AAPL", makeTicker("AAPL", "Apple Inc.", {
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
        makeTicker("TM", "Toyota Motor Corporation", {
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
        makeTicker("VTI", "Vanguard Total Stock Market ETF", {
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

  test("refreshes low-quality saved metadata when opening a provider-backed result", async () => {
    const existing = makeTicker("AAPL", "AAPL");
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
    const existing = makeTicker("AAPL", "Apple Inc.");
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
    expect(createLocalTickerSearchCandidates([makeTicker("TSLA", "Tesla")])).toEqual([
      expect.objectContaining({
        id: "goto:TSLA",
        label: "TSLA",
        category: "Saved",
        kind: "ticker",
      }),
    ]);
  });
});
