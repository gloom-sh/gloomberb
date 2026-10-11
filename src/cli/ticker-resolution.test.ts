import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import type { Quote } from "../types/financials";
import { ListingArgError, savedListingName } from "./listing-arg";
import { resolveCliTicker, resolveTickerForCli } from "./ticker-resolution";

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
  const retry = (key: string) => `gloomberb watchlist add Growth ${key}`;

  // One company: its first listing in search order with a quote, as `quote 123` reads it.
  const sassy = await resolveCliTicker("123", store, dataProvider, undefined, { retry });
  expect(sassy.ticker.metadata.exchange).toBe("FWB2");
  expect(sassy.notes).toEqual(["123 -> FWB2 (other listings: XSTU)"]);

  // Several companies: no listing is the answer, and each one offered is one the command takes.
  const choose = await failed(resolveCliTicker("2222", store, dataProvider, undefined, { retry }));
  expect(choose).toBeInstanceOf(ListingArgError);
  expect(choose?.message).toBe("Choose an exchange for 2222.");
  const offered = [...(choose?.details ?? "").matchAll(/try: gloomberb watchlist add Growth (\S+)\)/g)].map((match) => match[1]!);
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
