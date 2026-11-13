import { expect, test } from "bun:test";
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
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // How each venue answers: "yes", "busy", or after so many ms.
  type Answer = "yes" | "busy" | number;
  const run = async (symbols: string[], venues: { SGX: Answer; HKEX?: Answer }, venueWaitMs?: number) => {
    const persistence = new AppPersistence(":memory:");
    try {
      const store = new TickerRepository(persistence.tickers);
      // The book holds DBS on SGX already, and Tencent on HKEX when asked.
      await store.saveTicker(createTestTicker("D05:SGX", "DBS Group Holdings Ltd", { exchange: "SGX", currency: "SGD", watchlists: ["sg"] }));
      if (venues.HKEX) await store.saveTicker(createTestTicker("0700:HKEX", "Tencent Holdings Ltd", { exchange: "HKEX", currency: "HKD", watchlists: ["sg"] }));
      const answer = async (venue: string | undefined) => {
        const how = venue === "SGX" ? venues.SGX : venue === "HKEX" ? venues.HKEX : "yes";
        if (how === "busy") throw new ProviderBusyError();
        if (typeof how === "number") await sleep(how);
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
      const rows = await addSymbols({
        symbols, exchange: undefined, store, dataProvider, venueWaitMs,
        add: (ticker) => ({ ticker: { ...ticker, metadata: { ...ticker.metadata, watchlists: [...new Set([...ticker.metadata.watchlists, "sg"])] } }, changed: true }),
        member: (ticker) => ticker.metadata.watchlists.includes("sg"),
      });
      // A venue's lookup that finished after the add is saved nowhere.
      await sleep(150);
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
  // The venues are asked at once under one deadline: SGX answers late, HKEX in time that it has no ES3. The add asks,
  // and SGX's late answer saves no record of its own.
  const late = await run(["ES3"], { SGX: 80, HKEX: 10 }, 40);
  expect(late.rows).toEqual([["ES3", "failed",
    "ES3 may be ES3:SGX, on the list's venue, which did not answer, or the CME future ES3:CME; name the listing"]]);
  expect(late.saved).toEqual(["0700:HKEX@HKEX", "D05:SGX@SGX"]);
});
