import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import { createTestTicker } from "../test-support/ticker";
import type { DataProvider } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { TickerChanges } from "../types/ticker-changes";
import { ListingArgError, savedListingName } from "./listing-arg";
import { connectionHealth, GLOOM_CLOUD_HTTP_CONNECTION_ID } from "../core/connection-health";
import { ApiRequestError, markAskedTwice } from "../api-client/errors";
import { createProviderMiss, ProviderBusyError, SEARCH_BUSY_MESSAGE } from "../sources/provider-errors";
import { ListingChoiceError, resolveCliTicker, resolveTickerForCli, resolveTickersForCli } from "./ticker-resolution";
import { addSymbols, failedReason, failedRow } from "./symbol-rows";
import { resetBoardCoins } from "./board-coins";

const persistences: AppPersistence[] = [];

afterEach(() => {
  for (const persistence of persistences.splice(0)) persistence.close();
});

test("names a new listing from its own quote, not a catalogue row filed under another company", async () => {
  const quote = { symbol: "BA.L", price: 20.23, currency: "GBP", change: 0, changePercent: 0, lastUpdated: 1 };
  for (const [served, name] of [
    [{ ...quote, name: "BAE Systems plc", listingExchangeName: "LSE" }, "BAE Systems plc"],
    // Boeing's bare line, cached without a listing, must not rename the record.
    [{ ...quote, symbol: "BA", name: "Boeing Co/The", currency: "USD" }, "Boeing Co/The"],
  ] as const) {
    const persistence = new AppPersistence(":memory:");
    persistences.push(persistence);
    const store = new TickerRepository(persistence.tickers);
    const dataProvider = createTestDataProvider({
      search: async () => [
        { providerId: "test", symbol: "BA", name: "Boeing Co/The", exchange: "NYSE", currency: "USD", type: "Common Stock" },
        { providerId: "test", symbol: "BA", name: "Boeing Co/The", exchange: "LSE", currency: "GBp", type: "Common Stock" },
      ],
      getQuote: async (symbol, exchange) => {
        expect([symbol, exchange]).toEqual(["BA", "LSE"]);
        return served as Quote;
      },
    });

    const ticker = await resolveTickerForCli("BA:LSE", store, dataProvider);
    expect(ticker.metadata).toMatchObject({ exchange: "LSE", name });
    expect((await store.loadTicker(ticker.metadata.ticker))?.metadata.name).toBe(name);
  }
});

function tickerStore() {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  return new TickerRepository(persistence.tickers);
}

const failed = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ListingArgError);

test("a bare symbol no quote settles goes to the listing `quote` reads, and every listing a failure offers adds that listing", async () => {
  const row = { providerId: "test", currency: "EUR", type: "Common Stock" };
  const listings: Record<string, Array<{ name: string; exchange: string }>> = {
    "123": [{ name: "Sassy Gold Corp.", exchange: "FWB2" }, { name: "Sassy Gold Corp", exchange: "XSTU" }],
    "2222": [{ name: "Kotobuki Spirits Co., Ltd.", exchange: "JPX" }, { name: "Saudi Arabian Oil Co.", exchange: "TADAWUL" }],
  };
  const quoted = new Set(["123:XSTU", "123:FWB2", "2222:JPX", "2222:TADAWUL"]);
  const dataProvider = createTestDataProvider({
    search: async (query) => (listings[query.split(":")[0]!] ?? []).map((listing) => ({ ...row, symbol: query.split(":")[0]!, ...listing })),
    // Neither bare code has a quote of its own, as the service answers both.
    getQuote: async (symbol, exchange) => {
      if (!quoted.has(symbol) && !quoted.has(`${symbol}:${exchange}`)) throw new Error(`Not a ticker: ${symbol}.`);
      return createTestQuote({ symbol, currency: "EUR", listingExchangeName: exchange });
    },
  });
  const store = tickerStore();
  const retry = (key: string) => `gloom watchlist add Growth ${key}`;

  // One company: its first listing in search order with a quote, as `quote 123` reads it.
  const sassy = await resolveCliTicker("123", store, dataProvider, undefined, { retry });
  expect(sassy.ticker.metadata.exchange).toBe("FWB2");
  expect(sassy.notes).toEqual(["123 -> FWB2 (other listings: XSTU)"]);

  // Several companies: no listing is the answer, and each one offered is one the command takes.
  const choose = await failed(resolveCliTicker("2222", store, dataProvider, undefined, { retry }));
  expect(choose).toBeInstanceOf(ListingArgError);
  expect(choose?.message).toBe("Choose an exchange for 2222.");
  const offered = [...(choose?.details ?? "").matchAll(/try: gloom watchlist add Growth (\S+)\)/g)].map((match) => match[1]!);
  expect(offered).toEqual(["2222:JPX", "2222:TADAWUL"]);
  for (const key of offered) {
    expect(savedListingName((await resolveCliTicker(key, store, dataProvider)).ticker).key).toBe(key);
  }
});

test("a symbol search no longer lists says it stopped trading, and a venue it is not on names the ones it is", async () => {
  const twitter = createTestQuote({ symbol: "TWTR", price: 53.86, lastUpdated: Date.parse("2022-10-27T23:59:59.953Z"), stale: true });
  const fund = { providerId: "test", symbol: "IEO", name: "iShares U.S. Oil & Gas Exploration & Production ETF", currency: "USD", type: "ETF" };
  const dataProvider = createTestDataProvider({
    search: async (query) => query.startsWith("IEO") ? [{ ...fund, exchange: "BATS" }, { ...fund, exchange: "IEX" }] : [],
    getQuote: async (symbol, exchange) => symbol === "TWTR" ? twitter : createTestQuote({ symbol, listingExchangeName: exchange }),
  });
  const store = tickerStore();

  expect((await failed(resolveCliTicker("TWTR", store, dataProvider)))?.message)
    .toBe("TWTR: no longer trading since 2022-10-27 (last price $53.86).");
  // A quote that is merely behind is no reason to say so.
  expect((await failed(resolveCliTicker("TWTR", store, createTestDataProvider({
    getQuote: async () => ({ ...twitter, lastUpdated: Date.now() - 10 * 24 * 60 * 60_000 }),
  }))))?.message).toBe('No ticker match found for "TWTR".');

  const arca = await failed(resolveCliTicker("IEO:ARCA", store, dataProvider));
  expect(arca?.message).toBe("IEO does not trade on ARCA. IEO trades on: BATS, IEX.");
  for (const exchange of ["BATS", "IEX"]) {
    expect((await resolveCliTicker(`IEO:${exchange}`, store, dataProvider)).ticker.metadata.exchange).toBe(exchange);
  }
});

test("a symbol whose search the service refused is looked up again, never reported as not found", async () => {
  const nvda = { providerId: "test", symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ", currency: "USD", type: "Common Stock" };
  const lookUp = async (refusals: number) => {
    const persistence = new AppPersistence(":memory:");
    persistences.push(persistence);
    let refused = 0;
    const dataProvider = createTestDataProvider({
      // Search reads a refused request as no match; connection health is what saw it fail.
      search: async (query) => {
        if (query !== "NVDA") return [];
        if (refused < refusals) {
          refused += 1;
          connectionHealth.reportRequest(GLOOM_CLOUD_HTTP_CONNECTION_ID, {
            operation: "GET /market/search", success: false, latencyMs: refused, error: new Error("Anonymous market rate limit exceeded"),
          });
          return [];
        }
        return [nvda];
      },
    });
    const retries: number[] = [];
    const results = await resolveTickersForCli(["NVDA", "XXXXX"], new TickerRepository(persistence.tickers), dataProvider, undefined, {
      retryWaitsMs: [0, 0], onRetry: (count) => retries.push(count),
    });
    return { retries, outcomes: results.map((result) => result.ticker?.metadata.ticker ?? result.error?.message) };
  };

  expect(await lookUp(0)).toEqual({ retries: [], outcomes: ["NVDA", 'No ticker match found for "XXXXX".'] });
  expect(await lookUp(1)).toEqual({ retries: [2], outcomes: ["NVDA", 'No ticker match found for "XXXXX".'] });
  // Still refused after the last wait: neither symbol is called not found.
  const refusedThroughout = await lookUp(3);
  expect(refusedThroughout.retries).toEqual([2, 2]);
  expect(refusedThroughout.outcomes.every((outcome) => outcome?.startsWith("Could not look up"))).toBe(true);

  // A search no source answered in time is busy with no request failed yet: looked up again too.
  // 2 Nov 2026: seven symbols of a 300-name add ended "Search is busy" with no new look.
  const retries: number[] = [];
  const [entry] = await resolveTickersForCli(["NVDA"], tickerStore(), createTestDataProvider({
    search: async () => { if (retries.length === 0) throw new ProviderBusyError(SEARCH_BUSY_MESSAGE); return [nvda]; },
  }), undefined, { retryWaitsMs: [0, 0], onRetry: (count) => retries.push(count) });
  expect({ retries, ticker: entry?.ticker?.metadata.ticker }).toEqual({ retries: [1], ticker: "NVDA" });
});

test("a symbol the service answered nothing for stays not found while it refuses the others, never offered to try again", async () => {
  // 6 Nov 2026: a book's 46 refused symbols came back with "Try again in a minute", and that command returned the same 46.
  const looked: string[][] = [];
  const dataProvider = createTestDataProvider({
    search: async (query) => {
      connectionHealth.reportRequest(GLOOM_CLOUD_HTTP_CONNECTION_ID, {
        operation: "GET /market/search", success: false, latencyMs: looked.length, error: new Error("Anonymous market rate limit exceeded"),
      });
      return [];
    },
    getQuote: async (symbol) => { throw new Error(`Not a ticker: ${symbol}.`); },
  });
  // The batch answers XXXXX, found nothing; NVDA's search it leaves out, as a refused query.
  dataProvider.searchBatch = async (queries) => {
    looked.push([...queries]);
    return new Map(queries.filter((query) => query.startsWith("XXXXX")).map((query) => [query, []]));
  };
  dataProvider.getQuotesBatch = async (targets) => targets.map((target) => ({ target, quote: null, error: `Not a ticker: ${target.symbol}.` }));
  const retries: number[] = [];
  const results = await resolveTickersForCli(["NVDA", "XXXXX"], tickerStore(), dataProvider, undefined, {
    retryWaitsMs: [0, 0], onRetry: (count) => retries.push(count),
  });
  expect(retries).toEqual([1, 1]);
  expect(results.map((result) => result.error?.message)).toEqual([
    "Could not look up NVDA: Gloom Cloud did not answer. Try again in a minute.",
    'No ticker match found for "XXXXX".',
  ]);
});

test("what cannot be a symbol fails before any request, and never makes a list wait to look it up again", async () => {
  // Before, `$$$` and `N/A` were searched, failed with the refused requests around them, and were looked up
  // again after waits of 6, 15 and 30 s before being blamed on Gloom Cloud.
  const nvda = { providerId: "test", symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ", currency: "USD", type: "Common Stock" };
  const asked: string[] = [];
  const dataProvider = createTestDataProvider({
    search: async (query) => {
      asked.push(query);
      // Another request of the list was refused meanwhile, as when the service limits the rate.
      connectionHealth.reportRequest(GLOOM_CLOUD_HTTP_CONNECTION_ID, {
        operation: "GET /market/search", success: false, latencyMs: asked.length, error: new Error("Anonymous market rate limit exceeded"),
      });
      return query === "NVDA" ? [nvda] : [];
    },
    getQuote: async (symbol) => {
      asked.push(symbol);
      return createTestQuote({ symbol, listingExchangeName: "NASDAQ", exchangeName: "NASDAQ" });
    },
  });
  const retries: number[] = [];
  const junk = ["$$$", "N/A", "--", "-", "1.899", "2.582,52"];
  const results = await resolveTickersForCli([...junk, "NVDA"], tickerStore(), dataProvider, undefined, {
    retryWaitsMs: [60_000], onRetry: (count) => retries.push(count),
  });
  expect(retries).toEqual([]);
  // Only NVDA, in the spellings its search tries, was asked for.
  expect(asked.every((query) => query.replace(/[.-]/g, "") === "NVDA")).toBe(true);
  expect(results.map((result) => result.ticker?.metadata.ticker ?? result.error?.message)).toEqual([
    "$$$ is not a symbol.", "N/A is not a symbol.", "-- is not a symbol.", "- is not a symbol.",
    "1.899 is a number, not a symbol.", "2.582,52 is a number, not a symbol.", "NVDA",
  ]);
  expect(results.slice(0, junk.length).map((result) => failedRow(result.input, result.error!).status)).toEqual(junk.map(() => "not_a_symbol"));
});

test("batched answers that leave a symbol out, answer it with nothing, or come back out of order still give each symbol of a list its own listing", async () => {
  const row = (symbol: string) => ({ providerId: "test", symbol, name: `${symbol} Corp`, exchange: "NYSE", currency: "USD", type: "Common Stock" });
  const quote = (symbol: string) => createTestQuote({ symbol, name: `${symbol} Corp`, listingExchangeName: "NYSE", exchangeName: "NYSE", lastUpdated: Date.now() });
  const alone = { search: [] as string[], changes: [] as string[], quote: [] as string[] };
  const dataProvider = createTestDataProvider({
    // BBB is left out, CCC answered with no rows, and a query no symbol asked for is answered too.
    searchBatch: async () => new Map([["AAA", [row("AAA")]], ["CCC", []], ["DDD", [row("DDD")]], ["EEE", [row("EEE")]]]),
    search: async (query) => {
      alone.search.push(query);
      return [row(query)];
    },
    // AAA and BBB have nothing on record, CCC moved long ago, and DDD is left out.
    getTickerChangesBatch: async () => new Map<string, TickerChanges | null>([["AAA", null], ["BBB", null], ["CCC", {
      symbol: "CCC", moved: { symbol: "CCCX", name: "Old CCC Inc.", hops: [{ from: "CCC", to: "CCCX", date: "2015-01-02" }] },
      formerly: null, listedName: "CCC Corp", changes: [{ from: "CCC", to: "CCCX", date: "2015-01-02" }],
    }]]),
    getTickerChanges: async (symbol) => {
      alone.changes.push(symbol);
      return null;
    },
    // Answered in reverse, as copies of the targets; CCC left out and BBB answered with no quote.
    getQuotesBatch: async (targets) => targets.map(({ symbol, exchange }) => ({ target: { symbol, exchange }, quote: symbol === "BBB" ? null : quote(symbol) }))
      .filter(({ target }) => target.symbol !== "CCC").reverse(),
    getQuote: async (symbol) => {
      alone.quote.push(symbol);
      return quote(symbol);
    },
  });
  const results = await resolveTickersForCli(["AAA", "BBB", "CCC", "DDD"], tickerStore(), dataProvider, undefined, { retryWaitsMs: [] });
  expect(results.map((result) => [result.input, result.ticker?.metadata.ticker, result.ticker?.metadata.name])).toEqual([
    ["AAA", "AAA", "AAA Corp"], ["BBB", "BBB", "BBB Corp"], ["CCC", "CCC", "CCC Corp"], ["DDD", "DDD", "DDD Corp"],
  ]);
  expect(results.find((result) => result.input === "CCC")?.change).toMatchObject({ tradesAs: "CCCX" });
  // What a batch did not answer is asked one at a time, and only that.
  expect(alone.search.sort()).toEqual(["BBB", "CCC"]);
  expect(alone.changes).toEqual(["DDD"]);
  expect(alone.quote.sort()).toEqual(["BBB", "CCC"]);
});

test("a symbol whose company moved says where it trades now, as watchlist and portfolio adds print it; the symbol renamed into prints nothing", async () => {
  const fund = { providerId: "test", symbol: "FB", name: "ProShares S&P 500 Dynamic Daily Buffer ETF", exchange: "BATS", currency: "USD", type: "ETF" };
  const changes: Record<string, TickerChanges> = {
    FB: {
      symbol: "FB",
      moved: { symbol: "META", name: "Meta Platforms, Inc.", hops: [{ from: "FB", to: "META", date: "2022-06-09" }] },
      formerly: null,
      listedName: null,
      changes: [{ from: "FB", to: "META", date: "2022-06-09" }],
    },
    TRCH: {
      symbol: "TRCH",
      moved: { symbol: "MMATQ", name: null, hops: [{ from: "TRCH", to: "MMAT", date: "2021-07-06" }, { from: "MMAT", to: "MMATQ", date: "2024-08-21" }] },
      formerly: null,
      listedName: null,
      changes: [{ from: "TRCH", to: "MMAT", date: "2021-07-06" }],
    },
  };
  const provider = (getTickerChanges: DataProvider["getTickerChanges"]) => createTestDataProvider({
    search: async (query) => query === "FB" ? [fund] : [],
    getQuote: async (symbol) => {
      if (symbol !== "FB") throw new Error(`Not a ticker: ${symbol}.`);
      return createTestQuote({ symbol, name: fund.name, listingExchangeName: "BATS", lastUpdated: Date.now() });
    },
    getTickerChanges,
  });
  const online = provider(async (symbol) => changes[symbol] ?? null);

  const fb = await resolveCliTicker("FB", tickerStore(), online);
  expect(fb.notes).toEqual(["FB now lists ProShares S&P 500 Dynamic Daily Buffer ETF; FB was Meta Platforms before, now META (changed 2022-06-09)"]);
  expect(fb.change).toMatchObject({ kind: "moved", tradesAs: "META", listed: "ProShares S&P 500 Dynamic Daily Buffer ETF" });
  // Nothing lists the old symbol any more: the failure says where it went.
  expect((await failed(resolveCliTicker("TRCH", tickerStore(), online)))?.message)
    .toBe('No ticker match found for "TRCH". TRCH became MMAT on 2021-07-06, then MMATQ on 2024-08-21.');

  // A symbol with no change, or an offline service, adds nothing and fails nothing.
  const offline = provider(async () => { throw new Error("fetch failed"); });
  for (const dataProvider of [offline, provider(async () => null)]) {
    expect(await resolveCliTicker("FB", tickerStore(), dataProvider)).toMatchObject({ notes: [], change: null });
  }
  // The symbol a company renamed into is what was typed: the change is data, not a line.
  const renamedInto = provider(async () => ({ ...changes.FB!, moved: null, formerly: [{ from: "OLDFB", to: "FB", date: "2022-06-09" }] }));
  expect(await resolveCliTicker("FB", tickerStore(), renamedInto)).toMatchObject({ notes: [], change: { kind: "formerly" } });
});

test("a symbol several companies list names their listings and, when its own company moved, where it went, on its own and in a list", async () => {
  const row = { providerId: "test", symbol: "NEP", currency: "EUR", type: "Common Stock" };
  const dataProvider = createTestDataProvider({
    // Search no longer lists the US NEP, only two other companies' lines; its own quote stopped when it became XIFR.
    search: async (query) => query.startsWith("NEP")
      ? [{ ...row, name: "Nep Realty & Industry Public Company Ltd.", exchange: "SET" }, { ...row, name: "Sloman Neptun Schiffahrts-AG", exchange: "XHAM" }]
      : [],
    getQuote: async (symbol, exchange) => createTestQuote({
      symbol, name: "NextEra Energy Partners, LP", listingExchangeName: exchange || "NYSE", price: 10.47, stale: true,
      lastUpdated: Date.parse("2025-02-01T00:16:00Z"),
    }),
    getTickerChanges: async (symbol) => symbol === "NEP" ? {
      symbol: "NEP",
      moved: { symbol: "XIFR", name: "XPLR Infrastructure, LP", hops: [{ from: "NEP", to: "XIFR", date: "2025-02-03" }] },
      formerly: null,
      listedName: null,
      changes: [{ from: "NEP", to: "XIFR", date: "2025-02-03" }],
    } : null,
  });
  const retry = (key: string) => `gloom watchlist add Growth ${key}`;

  const alone = await failed(resolveCliTicker("NEP", tickerStore(), dataProvider, undefined, { retry }));
  expect(alone).toBeInstanceOf(ListingChoiceError);
  expect(alone?.message).toBe("Choose an exchange for NEP.");
  expect(alone?.details?.split("\n").at(-1)).toBe("NEP became XIFR on 2025-02-03: `gloom watchlist add Growth XIFR`");

  // A list's line says the same in one line, also past the length that skips change lookups for the rest.
  for (const symbols of [["NEP", "ZZ"], ["NEP", ...Array.from({ length: 10 }, (_, index) => `ZZ${index}`)]]) {
    const [nep] = await resolveTickersForCli(symbols, tickerStore(), dataProvider, undefined, { retry, retryWaitsMs: [] });
    const failure = failedRow("NEP", nep!.error!);
    expect(failure.choices?.map((choice) => choice.key)).toEqual(["NEP:SET", "NEP:XHAM"]);
    expect(failedReason(failure, "NEP")).toBe("Choose an exchange for NEP: NEP:SET, NEP:XHAM; NEP became XIFR on 2025-02-03");
  }
});

test("a bare symbol whose line stopped trading as its company moved needs a choice, and one whose quote was refused is looked at again before it counts as trading", async () => {
  const day = 24 * 60 * 60_000;
  // Rite Aid's old line: search's bare US row names no venue, and neither does the quote that says it stopped.
  const rad = { providerId: "test", symbol: "RAD", name: "RAD", exchange: "", currency: "USD", type: "Common Stock" };
  const oldco = { ...rad, symbol: "OLDCO", name: "Oldco Inc.", exchange: "NYSE" };
  const changes: Record<string, TickerChanges> = {
    RAD: { symbol: "RAD", moved: { symbol: "RADCQ", name: null, hops: [{ from: "RAD", to: "RADCQ", date: "2023-10-17" }] },
      formerly: null, listedName: null, changes: [{ from: "RAD", to: "RADCQ", date: "2023-10-17" }] },
  };
  const ended = (symbol: string, exchange?: string) => createTestQuote({
    symbol, price: 0.65, lastUpdated: Date.now() - 1_000 * day, stale: true,
    ...exchange ? { listingExchangeName: exchange, exchangeName: exchange } : {},
    delisting: { status: "inactive", lastTradeDate: "2023-10-13", historyStart: "2019-04-22" },
  });
  /** A source that refuses OLDCO's quote this many times while it limits the rate, as connection health sees it. */
  const source = (refusals: number) => {
    let refused = 0;
    return createTestDataProvider({
      search: async (query) => query === "RAD" ? [rad] : query === "OLDCO" ? [oldco] : [],
      getQuote: async (symbol, exchange) => {
        if (symbol === "RAD") return ended("RAD");
        if (refused < refusals) {
          refused += 1;
          connectionHealth.reportRequest(GLOOM_CLOUD_HTTP_CONNECTION_ID, {
            operation: "POST /market/quotes", success: false, latencyMs: refused, error: new Error("Anonymous market rate limit exceeded"),
          });
          throw new Error("Anonymous market rate limit exceeded");
        }
        return ended("OLDCO", exchange || "NYSE");
      },
      getTickerChanges: async (symbol) => changes[symbol] ?? null,
    });
  };

  // A listing named in a feed's capitals reads as a name: Chesapeake Energy, never CHESAPEAKE ENERGY CORP or its successor's.
  const chk = { ...rad, symbol: "CHK", name: "CHESAPEAKE ENERGY CORP" };
  const chesapeake = createTestDataProvider({
    search: async (query) => query === "CHK" ? [chk] : [],
    getQuote: async () => ({ ...ended("CHK"), name: "CHESAPEAKE ENERGY CORP" }),
    getTickerChanges: async () => ({ symbol: "CHK", moved: { symbol: "EXE", name: "EXPAND ENERGY CORP", hops: [{ from: "CHK", to: "EXE", date: "2024-10-02" }] },
      formerly: null, listedName: null, changes: [{ from: "CHK", to: "EXE", date: "2024-10-02" }] }),
  });
  const [renamed] = await addSymbols({ symbols: ["CHK"], store: tickerStore(), dataProvider: chesapeake, add: (ticker) => ({ ticker, changed: true }) });
  expect(renamed?.message).toBe("Chesapeake Energy (CHK) stopped trading 2024-10-02, now EXE");

  const rows = await addSymbols({ symbols: ["RAD", "OLDCO"], store: tickerStore(), dataProvider: source(0), add: (ticker) => ({ ticker, changed: true }) });
  expect(rows.map((row) => [row.status, row.message ?? null, row.tradesAs ?? null])).toEqual([
    ["needs_choice", "RAD stopped trading 2023-10-17, now RADCQ", "RADCQ"],
    ["needs_choice", "OLDCO:NYSE (Oldco Inc.): Last traded 13 Oct 2023 (last price $0.65)", null],
  ]);
  // Saved already, as an add before this check left it, its old line is no listing under the symbol now.
  const saved = tickerStore();
  await saved.saveTicker(createTestTicker("RAD", "RAD", { exchange: "" }));
  const again = await addSymbols({ symbols: ["RAD", "OLDCO"], store: saved, dataProvider: source(0), add: (ticker) => ({ ticker, changed: true }) });
  expect(again[0]).toMatchObject({ status: "needs_choice", message: "RAD stopped trading 2023-10-17, now RADCQ" });

  const lookUp = async (refusals: number) => {
    const retries: number[] = [];
    const [, entry] = await resolveTickersForCli(["RAD", "OLDCO"], tickerStore(), source(refusals), undefined, {
      retryWaitsMs: [0, 0], onRetry: (count) => retries.push(count),
    });
    return { retries, ended: entry?.ended ?? null, error: entry?.error?.message ?? null };
  };
  // Refused through the first look (its own quote, then the match's): looked at again, and checked as a first look checks it.
  expect(await lookUp(2)).toEqual({ retries: [1], ended: "OLDCO:NYSE (Oldco Inc.): Last traded 13 Oct 2023 (last price $0.65)", error: null });
  // Refused throughout: not looked up, never taken as trading.
  expect(await lookUp(10)).toEqual({ retries: [1, 1], ended: null, error: "Could not look up OLDCO: Gloom Cloud did not answer. Try again in a minute." });
  // A quote the service fails for the listing itself, on every look, while other requests are refused: no wait, and the
  // match stands (review: it cost both waits and ended as "did not answer").
  for (const own of [createProviderMiss("Cloud quotes are unavailable for OLDCO"), markAskedTwice(new ApiRequestError("Quote source failed", 500))]) {
    const retries: number[] = [];
    const failing = createTestDataProvider({
      search: async (query) => query === "OLDCO" ? [oldco] : [],
      getQuote: async () => {
        connectionHealth.reportRequest(GLOOM_CLOUD_HTTP_CONNECTION_ID, {
          operation: "POST /market/quotes", success: false, latencyMs: retries.length + Math.random(), error: own,
        });
        throw own;
      },
    });
    const [entry] = await resolveTickersForCli(["OLDCO"], tickerStore(), failing, undefined, { retryWaitsMs: [0, 0], onRetry: (count) => retries.push(count) });
    expect({ retries, ticker: entry?.ticker?.metadata.ticker ?? null, error: entry?.error?.message ?? null }, own.message)
      .toEqual({ retries: [], ticker: "OLDCO", error: null });
  }
});

// A bank paste stored ZION:IEX, FRC:BMV and SBNY as if they quoted, and BRK.B beside BRK-B.
test("a list add never stores a listing that cannot quote or stopped trading silently, and one share class is one row", async () => {
  const day = 24 * 60 * 60_000;
  const row = (symbol: string, exchange: string, name: string) => ({ providerId: "test", symbol, name, exchange, currency: "USD", type: "Common Stock" });
  const rows: Record<string, ReturnType<typeof row>[]> = {
    // Search lists a quote-less IEX line first; the symbol's own quote names its NASDAQ listing.
    QLES: [row("QLES", "IEX", "Quoteless Bancorp")],
    "ZION:IEX": [row("ZION", "IEX", "Zions Bancorporation N.A.")],
    ZION: [row("ZION", "IEX", "Zions Bancorporation N.A.")],
    // A failed bank: search still lists its old NASDAQ line, while the symbol's own quote is an OTC line that stopped.
    DEADB: [row("DEADB", "NASDAQ", "Dead Bank-New York NY")],
    // Merged away: search answers its old name with the company it went to.
    COMERICA: [{ ...row("FITB", "NASDAQ", "Fifth Third Bancorp"), searchAliases: ["COMERICA INC"],
      formerIssuer: { symbol: "CMA", name: "COMERICA INC", until: "2026-02-02", successor: { symbol: "FITB", name: "Fifth Third Bancorp" } } }],
  };
  const quotes: Record<string, Quote> = {
    "DEADB|": createTestQuote({ symbol: "DEADB", price: 0.95, lastUpdated: Date.now() - 270 * day, stale: true, listingExchangeName: "OTC", exchangeName: "OTC" }),
    "DEADB|NASDAQ": createTestQuote({ symbol: "DEADB", price: 0.18, listingExchangeName: "NASDAQ", exchangeName: "NASDAQ" }),
    "BRK.B|": createTestQuote({ symbol: "BRK.B", name: "Berkshire Hathaway Inc.", listingExchangeName: "NYSE", exchangeName: "NYSE" }),
    "BRK-B|": createTestQuote({ symbol: "BRK-B", name: "Berkshire Hathaway Inc.", listingExchangeName: "NYSE", exchangeName: "NYSE" }),
  };
  const dataProvider = createTestDataProvider({
    search: async (query) => rows[query.toUpperCase()] ?? [],
    getQuote: async (symbol, exchange = "") => {
      const quote = quotes[`${symbol}|${exchange}`];
      if (!quote) throw createProviderMiss(`No quote provider available for ${symbol}`);
      return quote;
    },
  });
  const store = tickerStore();
  const listed = new Set<string>();
  const added = await addSymbols({
    symbols: ["QLES", "ZION:IEX", "DEADB", "Comerica", "BRK.B", "BRK-B"], store, dataProvider,
    add: (ticker) => ({ ticker, changed: !listed.has(ticker.metadata.ticker) && !!listed.add(ticker.metadata.ticker) }),
  });
  expect(added.map((entry) => [entry.input, entry.status, entry.message ?? null, entry.tradesAs ?? null])).toEqual([
    ["QLES", "needs_choice", "QLES:IEX (Quoteless Bancorp) has no quote", null],
    // A listing named on purpose is kept, its row saying it has no quote.
    ["ZION:IEX", "added", "no quote", null],
    ["DEADB", "needs_choice", expect.stringMatching(/^DEADB: no longer trading since \d{4}-\d{2}-\d{2} \(last price \$0\.95\)$/), null],
    ["Comerica", "needs_choice", 'No ticker match found for "COMERICA". CMA was COMERICA until 2026, now Fifth Third Bancorp: FITB.', "FITB"],
    ["BRK.B", "added", null, null],
    ["BRK-B", "already_listed", null, null],
  ]);
  // Nothing that needs a choice is stored; BRK-B is BRK.B's row.
  expect((await store.loadAllTickers()).map(({ metadata }) => `${metadata.ticker}:${metadata.exchange}`).sort()).toEqual(["BRK.B:NYSE", "ZION:IEX"]);
});

test("a list's one-word company name no listing trades as is read as quote reads it; a word that names none stays not found", async () => {
  const listed = (symbol: string, name: string, exchange: string) => ({ providerId: "test", symbol, name, exchange, type: "Common Stock", currency: "JPY" });
  const dataProvider = createTestDataProvider({
    search: async (query) => /^(canon|7751)\b/i.test(query) ? [listed("7751", "Canon Inc.", "JPX")] : [],
    getQuote: async (symbol, exchange) => {
      if (exchange === "JPX") return createTestQuote({ symbol, exchange: "JPX", currency: "JPY" });
      throw new Error(`Not a ticker: ${symbol}.`);
    },
  });
  // The crypto board, read before a word is taken as a company, lists no Canon (and is never fetched here).
  resetBoardCoins([]);
  const results = await resolveTickersForCli(["Canon", "Zorblaxx"], tickerStore(), dataProvider, undefined, { retryWaitsMs: [] }).finally(() => resetBoardCoins());
  expect(results.map((result) => result.ticker ? `${result.ticker.metadata.ticker}:${result.ticker.metadata.exchange}` : result.error?.message))
    .toEqual(["7751:JPX", 'No ticker match found for "ZORBLAXX".']);
  expect(results[0]?.readAs).toBe('Read "Canon" as 7751:JPX (Canon Inc.).');
});

test("a list's word written as a name that went to another company's ticker is the company of that name, as quote reads it", async () => {
  const listed = (symbol: string, name: string, exchange: string, homeListing = false) =>
    ({ providerId: "test", symbol, name, exchange, type: "Common Stock", currency: "USD", ...homeListing ? { homeListing } : {} });
  const answer = [listed("AEON", "AEON Biopharma, Inc.", "AMEX"), listed("8267", "Aeon Co., Ltd.", "JPX", true)];
  const dataProvider = createTestDataProvider({
    search: async (query) => /^(aeon|8267)\b/i.test(query) ? answer : [],
    getQuote: async (symbol, exchange) => createTestQuote({
      symbol, exchange: exchange || "AMEX", name: exchange === "JPX" || symbol.startsWith("8267") ? "Aeon Co., Ltd." : "AEON Biopharma, Inc.",
    }),
  });
  resetBoardCoins([]);
  const results = await resolveTickersForCli(["Aeon", "AEON"], tickerStore(), dataProvider, undefined, { retryWaitsMs: [] }).finally(() => resetBoardCoins());
  expect(results.map((result) => result.ticker ? `${result.ticker.metadata.ticker}:${result.ticker.metadata.exchange}` : result.error?.message))
    .toEqual(["8267:JPX", "AEON:AMEX"]);
  expect(results[0]?.readAs).toBe('Read "Aeon" as 8267:JPX (Aeon Co., Ltd.); the ticker AEON is AEON Biopharma, Inc.');
});

test("a list's word the service marks as a company's name is that company, before a line abroad under the word, as quote reads it", async () => {
  // `search VISA` against the service, 2026-11-06, trimmed: VISA is a receipt on Toronto; the service marks Visa Inc.'s V with the word.
  const listed = (symbol: string, name: string, exchange: string, extra: Record<string, unknown> = {}) =>
    ({ providerId: "test", symbol, name, exchange, type: "Common Stock", currency: "USD", ...extra });
  const answer = [listed("VISA", "Visa Inc.", "TSX", { currency: "CAD" }), listed("V", "Visa Inc.", "NYSE", { homeListing: true, searchAliases: ["visa"] })];
  const dataProvider = createTestDataProvider({
    search: async (query) => /^(visa|v)\b/i.test(query) ? answer : [],
    getQuote: async (symbol, exchange) => {
      if (exchange) return createTestQuote({ symbol, exchange, name: "Visa Inc." });
      throw new Error(`No quote provider available for ${symbol}`);
    },
  });
  resetBoardCoins([]);
  const results = await resolveTickersForCli(["VISA"], tickerStore(), dataProvider, undefined, { retryWaitsMs: [] }).finally(() => resetBoardCoins());
  expect(results.map((result) => result.ticker ? `${result.ticker.metadata.ticker}:${result.ticker.metadata.exchange}` : result.error?.message)).toEqual(["V:NYSE"]);
  expect(results[0]?.readAs).toBe('Read "VISA" as V:NYSE (Visa Inc.).');
});
