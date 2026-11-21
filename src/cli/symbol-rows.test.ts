import { expect, jest, test } from "bun:test";
import { summarizeSymbolRows, type SymbolRow } from "./symbol-rows";

const added = (input: string, symbol: string, exchange: string): SymbolRow => ({
  input, status: "added", listing: `${symbol}:${exchange}`, symbol, exchange, name: symbol, message: null, notes: null, hint: null,
});

test("a list add names the rows that landed off the list's main venues, the US exchanges as one market and a pair as none", () => {
  const book = [
    ...Array.from({ length: 6 }, (_, index) => added(`L${index}.L`, `L${index}`, "LSE")),
    ...Array.from({ length: 5 }, (_, index) => added(`${7200 + index}.T`, String(7200 + index), "JPX")),
    added("BP", "BP", "NYSE"), added("NTT", "NTT", "WSE"), added("GBPUSD=X", "GBPUSD=X", "CCY"),
  ];
  expect(summarizeSymbolRows(book, "add", 0)).toBe("14 added; 2 landed outside the list's main venues (LSE, JPX): BP as BP:NYSE, NTT as NTT:WSE.");
  // A US list on NYSE and NASDAQ is on one market.
  const us = Array.from({ length: 10 }, (_, index) => added(`U${index}`, `U${index}`, index % 2 ? "NYSE" : "NASDAQ"));
  expect(summarizeSymbolRows(us, "add", 0)).toBe("10 added.");
});

test("codes left for a choice of exchange that all list on the list's venue name the one --exchange that adds them", () => {
  // Each said "Choose an exchange" with its own listings, so the paste's 29 codes had 29 answers to give.
  const choice = (code: string, ...venues: string[]): SymbolRow => ({
    input: code, status: "failed", listing: null, symbol: null, exchange: null, name: null, message: `Choose an exchange for ${code}.`,
    notes: null, hint: null, choices: venues.map((venue) => ({ key: `${code}:${venue}`, name: null })),
  });
  const tokyo = [added("8058:JPX", "8058", "JPX"), added("7203.T", "7203", "JPX"), choice("8053", "JPX", "HKEX"), choice("2282", "HKEX", "JPX", "TADAWUL")];
  expect(summarizeSymbolRows(tokyo, "add", 0))
    .toBe("2 added; 2 not added: 8053, 2282 (each lists on JPX: add them with --exchange JPX).");
  // Two venues shared and neither the list's says nothing, as does a code alone.
  expect(summarizeSymbolRows([choice("8053", "JPX", "HKEX"), choice("8001", "JPX", "HKEX")], "add", 0)).toBe("0 added; 2 not added: 8053, 8001.");
  expect(summarizeSymbolRows([added("7203.T", "7203", "JPX"), choice("8053", "JPX", "HKEX")], "add", 0)).toBe("1 added; 1 not added: 8053.");
});

test("a bare symbol that reads as a future keeps the list's venue when it lists there, asks when that venue does not answer, and a future's own spelling stays one", async () => {
  const { AppPersistence } = await import("../data/app-persistence");
  const { TickerRepository } = await import("../data/ticker-repository");
  const { createTestDataProvider, createTestQuote } = await import("../test-support/data-provider");
  const { createTestTicker } = await import("../test-support/ticker");
  const { addSymbols } = await import("./symbol-rows");
  const { ProviderBusyError } = await import("../sources/provider-errors");
  const listings: Record<string, { name: string; exchange: string; type: string; currency: string }> = {
    "ES3:SGX": { name: "SPDR Straits Times Index ETF", exchange: "SGX", type: "ETF", currency: "SGD" },
    "D05:SGX": { name: "DBS Group Holdings Ltd", exchange: "SGX", type: "Common Stock", currency: "SGD" },
    "0700:HKEX": { name: "Tencent Holdings Ltd", exchange: "HKEX", type: "Common Stock", currency: "HKD" },
  };
  // A bare ES3, NQ1 or ES=F is a CME future, as the service reads it.
  const futures: Record<string, string> = { ES3: "E-Mini S&P 500 3rd generic", NQ1: "E-Mini Nasdaq 100 1st generic", "ES=F": "E-Mini S&P 500" };
  // How each venue answers: "yes", "busy", or once the promise given resolves.
  type Answer = "yes" | "busy" | Promise<void>;
  // The lookups each venue has been asked and has answered so far.
  type Calls = Record<"SGX" | "HKEX", { asked: number; answered: number }>;
  // One turn of the event loop. These lookups run on microtasks alone (no I/O, and no timer unless the test advances
  // the fake clock), so by the time it returns every lookup that can answer without the test has answered.
  const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
  // The add's next read of a symbol's record, held until opened; `reached` resolves once the add is waiting on it.
  type Hold = { reached: Promise<void>; open: () => void };
  // `during` runs beside the add, from the start of it, and may hold the add at its reads of the book.
  const run = async (symbols: string[], venues: { SGX: Answer; HKEX?: Answer }, { venueWaitMs, during }: {
    venueWaitMs?: number; during?: (add: { calls: Calls; holdRead: (symbol: string) => Hold }) => Promise<void>;
  } = {}) => {
    const persistence = new AppPersistence(":memory:");
    try {
      const store = new TickerRepository(persistence.tickers);
      // The book holds DBS on SGX already, and Tencent on HKEX when asked.
      await store.saveTicker(createTestTicker("D05:SGX", "DBS Group Holdings Ltd", { exchange: "SGX", currency: "SGD", watchlists: ["sg"] }));
      if (venues.HKEX) await store.saveTicker(createTestTicker("0700:HKEX", "Tencent Holdings Ltd", { exchange: "HKEX", currency: "HKD", watchlists: ["sg"] }));
      const calls: Calls = { SGX: { asked: 0, answered: 0 }, HKEX: { asked: 0, answered: 0 } };
      const answer = async (venue: string | undefined) => {
        const how = venue === "SGX" ? venues.SGX : venue === "HKEX" ? venues.HKEX : "yes";
        const tally = venue === "SGX" || venue === "HKEX" ? calls[venue] : undefined;
        if (tally) tally.asked++;
        try {
          if (how === "busy") throw new ProviderBusyError();
          if (how instanceof Promise) await how;
        } finally {
          if (tally) tally.answered++;
        }
      };
      const holds = new Map<string, { reached: PromiseWithResolvers<void>; open: PromiseWithResolvers<void> }>();
      const holdRead = (symbol: string): Hold => {
        const hold = { reached: Promise.withResolvers<void>(), open: Promise.withResolvers<void>() };
        holds.set(symbol, hold);
        return { reached: hold.reached.promise, open: () => hold.open.resolve() };
      };
      const loadTicker = store.loadTicker.bind(store);
      store.loadTicker = async (symbol) => {
        const hold = holds.get(symbol);
        if (hold) {
          hold.reached.resolve();
          await hold.open.promise;
        }
        return loadTicker(symbol);
      };
      const dataProvider = createTestDataProvider({
        search: async (query) => {
          const [bare, venue] = query.split(":");
          await answer(venue);
          if (!venue && futures[bare!]) return [{ providerId: "test", symbol: bare!, name: futures[bare!]!, exchange: "CME", currency: "USD", type: "Future" }];
          return Object.entries(listings).filter(([key]) => key === `${bare}:${venue}`)
            .map(([key, row]) => ({ providerId: "test", symbol: key.split(":")[0]!, name: row.name, exchange: row.exchange, currency: row.currency, type: row.type }));
        },
        getQuote: async (symbol, exchange) => {
          const [bare, venue] = symbol.includes(":") ? symbol.split(":") : [symbol, exchange];
          await answer(venue);
          if (!venue && futures[bare!]) return createTestQuote({ symbol: bare!, name: futures[bare!]!, currency: "USD", listingExchangeName: "CME", instrumentType: "Future" });
          const listing = listings[`${bare}:${venue}`];
          if (!listing) throw new Error(`Not a ticker: ${symbol}.`);
          return createTestQuote({ symbol: bare!, name: listing.name, currency: listing.currency, listingExchangeName: listing.exchange, instrumentType: listing.type });
        },
      });
      const adding = addSymbols({
        symbols, exchange: undefined, store, dataProvider, venueWaitMs,
        add: (ticker) => ({ ticker: { ...ticker, metadata: { ...ticker.metadata, watchlists: [...new Set([...ticker.metadata.watchlists, "sg"])] } }, changed: true }),
        member: (ticker) => ticker.metadata.watchlists.includes("sg"),
      });
      try {
        await during?.({ calls, holdRead });
      } finally {
        for (const hold of holds.values()) hold.open.resolve();
      }
      const rows = await adding;
      const saved = (await store.loadAllTickers()).map((ticker) => `${ticker.metadata.ticker}@${ticker.metadata.exchange}`).sort();
      return { rows: rows.map((row) => [row.input, row.status, row.listing ?? row.message]), saved };
    } finally {
      persistence.close();
    }
  };
  // A book on SGX: ES3 is the fund there, not the CME future.
  expect((await run(["ES3"], { SGX: "yes" })).rows).toEqual([["ES3", "added", "ES3:SGX"]]);
  // SGX does not answer: the add asks which was meant rather than store the future.
  expect((await run(["ES3"], { SGX: "busy" })).rows).toEqual([["ES3", "failed",
    "ES3 may be ES3:SGX, on the list's venue, which did not answer, or the CME future ES3:CME; name the listing"]]);
  // A future named on purpose, a front generic or a continuous symbol stays one, without asking SGX.
  expect((await run(["ES3:CME", "NQ1", "ES=F"], { SGX: "busy" })).rows).toEqual([
    ["ES3:CME", "added", "ES3:CME"], ["NQ1", "added", "NQ1:CME"], ["ES=F", "added", "ES=F:CME"],
  ]);
  // The venues are asked at once under one deadline: HKEX answers in time that it has no ES3, SGX only after the
  // deadline has passed. The add asks, and SGX's late answer saves no record of its own. The clock and SGX's answer are
  // both held by the test, so how fast the machine is never decides which venue was in time. A second symbol gives the
  // add a read of the book to wait on after its deadline, so SGX answers while the add is still open and could still
  // write what the late lookup saved.
  jest.useFakeTimers();
  try {
    const sgx = Promise.withResolvers<void>();
    const late = await run(["ES3", "0700:HKEX"], { SGX: sgx.promise, HKEX: "yes" }, {
      venueWaitMs: 40,
      during: async ({ calls, holdRead }) => {
        await drain();
        expect(calls.HKEX.asked).toBeGreaterThan(0);
        expect(calls.HKEX.answered).toBe(calls.HKEX.asked);
        expect(calls.SGX.asked).toBeGreaterThan(0);
        expect(calls.SGX.answered).toBe(0);
        const tencent = holdRead("0700:HKEX");
        jest.advanceTimersByTime(40);
        await tencent.reached;
        sgx.resolve();
        await drain();
        expect(calls.SGX.answered).toBe(calls.SGX.asked);
        tencent.open();
      },
    });
    expect(late.rows).toEqual([
      ["ES3", "failed", "ES3 may be ES3:SGX, on the list's venue, which did not answer, or the CME future ES3:CME; name the listing"],
      ["0700:HKEX", "added", "0700:HKEX"],
    ]);
    expect(late.saved).toEqual(["0700:HKEX@HKEX", "D05:SGX@SGX"]);
  } finally {
    jest.useRealTimers();
  }
});
