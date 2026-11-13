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

test("a bare symbol that reads as a future keeps the list's venue when it lists there, and asks when that venue does not answer", async () => {
  const { AppPersistence } = await import("../data/app-persistence");
  const { TickerRepository } = await import("../data/ticker-repository");
  const { createTestDataProvider, createTestQuote } = await import("../test-support/data-provider");
  const { createTestTicker } = await import("../test-support/ticker");
  const { addSymbols } = await import("./symbol-rows");
  const { ProviderBusyError } = await import("../sources/provider-errors");
  const listings: Record<string, { name: string; exchange: string; type: string; currency: string }> = {
    "ES3:CME": { name: "E-Mini S&P 500 3rd generic", exchange: "CME", type: "Future", currency: "USD" },
    "ES3:SGX": { name: "SPDR Straits Times Index ETF", exchange: "SGX", type: "ETF", currency: "SGD" },
    "D05:SGX": { name: "DBS Group Holdings Ltd", exchange: "SGX", type: "Common Stock", currency: "SGD" },
  };
  const run = async (sgxAnswers: boolean, symbols: string[]) => {
    const persistence = new AppPersistence(":memory:");
    try {
      const store = new TickerRepository(persistence.tickers);
      // The book holds DBS on SGX already.
      await store.saveTicker(createTestTicker("D05:SGX", "DBS Group Holdings Ltd", { exchange: "SGX", currency: "SGD", watchlists: ["sg"] }));
      const listingOf = (symbol: string, exchange?: string) => {
        const [bare, venue] = symbol.includes(":") ? symbol.split(":") : [symbol, exchange];
        // A bare ES3 is the E-mini's third generic, as the service reads it.
        return venue ? listings[`${bare}:${venue}`] && { symbol: bare!, ...listings[`${bare}:${venue}`]! } : bare === "ES3" ? { symbol: "ES3", ...listings["ES3:CME"]! } : null;
      };
      const dataProvider = createTestDataProvider({
        search: async (query) => {
          const [bare, venue] = query.split(":");
          if (venue === "SGX" && !sgxAnswers) throw new ProviderBusyError();
          return Object.entries(listings).filter(([key]) => key.startsWith(`${bare}:`) && (!venue || key.endsWith(`:${venue}`)) && (venue || key.endsWith(":CME")))
            .map(([key, row]) => ({ providerId: "test", symbol: key.split(":")[0]!, name: row.name, exchange: row.exchange, currency: row.currency, type: row.type }));
        },
        getQuote: async (symbol, exchange) => {
          const listing = listingOf(symbol, exchange);
          if (listing?.exchange === "SGX" && !sgxAnswers) throw new ProviderBusyError();
          if (!listing) throw new Error(`Not a ticker: ${symbol}.`);
          return createTestQuote({ symbol: listing.symbol, name: listing.name, currency: listing.currency, listingExchangeName: listing.exchange, instrumentType: listing.type });
        },
      });
      const rows = await addSymbols({
        symbols, exchange: undefined, store, dataProvider,
        add: (ticker) => ({ ticker: { ...ticker, metadata: { ...ticker.metadata, watchlists: [...new Set([...ticker.metadata.watchlists, "sg"])] } }, changed: true }),
        member: (ticker) => ticker.metadata.watchlists.includes("sg"),
      });
      return rows.map((row) => [row.input, row.status, row.listing ?? row.message]);
    } finally {
      persistence.close();
    }
  };
  // A book on SGX: ES3 is the fund there, not the CME future.
  expect(await run(true, ["ES3"])).toEqual([["ES3", "added", "ES3:SGX"]]);
  // SGX does not answer: the add asks which was meant rather than store the future.
  expect(await run(false, ["ES3"])).toEqual([["ES3", "failed",
    "ES3 may be ES3:SGX, on the list's venue, which did not answer, or the CME future ES3:CME; name the listing"]]);
  // A future named on purpose stays one.
  expect(await run(true, ["ES3:CME"])).toEqual([["ES3:CME", "added", "ES3:CME"]]);
});
