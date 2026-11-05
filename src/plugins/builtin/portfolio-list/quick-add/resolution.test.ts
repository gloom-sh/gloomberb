import { afterEach, describe, expect, test } from "bun:test";
import type { InstrumentSearchResult } from "../../../../types/instrument";
import type { PluginRegistry } from "../../../registry";
import { setSharedRegistryForTests } from "../../../registry";
import { createTestDataProvider, createTestQuote } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";
import {
  createQuickAddListMemo, exchangeLabelFromValidation, isPlausibleTickerQuery, mayBeQuickAddList, normalizeQuickAddQuery, QUICK_ADD_LIST_MAX,
  QUICK_ADD_REFUSAL, readQuickAddEntries, resolveQuickAddList, resolveQuickAddValidation, tickerNameFromValidation,
} from "./resolution";

const nyse: InstrumentSearchResult = {
  providerId: "test", symbol: "NET", name: "Cloudflare", exchange: "NYSE", currency: "USD", type: "STK",
};
const lse: InstrumentSearchResult = {
  providerId: "test", symbol: "NET", name: "Netcall Plc", exchange: "LSE", currency: "GBP", type: "STK",
};

afterEach(() => {
  setSharedRegistryForTests(undefined);
});

describe("quick-add listing resolution", () => {
  test("a symbol whose default listing is unknown asks which one instead of failing", async () => {
    setSharedRegistryForTests({
      marketData: createTestDataProvider({
        search: async () => [lse, nyse],
        getQuote: async () => { throw new Error("quote unavailable"); },
      }),
    } as PluginRegistry);
    const validation = await resolveQuickAddValidation({
      query: "NET",
      collectionId: "watchlist",
      collectionKind: "watchlist",
      tickers: new Map(),
      financials: new Map(),
    });
    expect(validation).toEqual({ status: "choose", query: "NET" });
  });

  test("a qualified listing neither borrows nor duplicates another listing saved under its symbol", async () => {
    setSharedRegistryForTests({
      marketData: createTestDataProvider({
        search: async () => [lse, nyse],
        getQuote: async (_symbol, exchange) => createTestQuote({
          symbol: "NET", listingExchangeName: exchange, currency: exchange === "NYSE" ? "USD" : "GBP",
          price: exchange === "NYSE" ? 200 : 1.26,
        }),
      }),
    } as PluginRegistry);
    const saved = createTestTicker("NET", "Cloudflare", { exchange: "NYSE", currency: "USD", watchlists: ["watchlist"] });
    const validation = await resolveQuickAddValidation({
      query: "NET.LON",
      collectionId: "watchlist",
      collectionKind: "watchlist",
      tickers: new Map([[saved.metadata.ticker, saved]]),
      financials: new Map([["NET", { quote: createTestQuote({ symbol: "NET", price: 200, currency: "USD" }) }]]),
    });
    expect(validation.status).toBe("ready");
    if (validation.status !== "ready") return;
    expect(validation.ticker).toBeNull();
    expect(validation.quote?.price).toBe(1.26);
    expect(tickerNameFromValidation(validation)).toBe("Netcall Plc");
    expect(exchangeLabelFromValidation(validation)).toBe("LSE");
  });

  test("a listing found through its own quote is priced from that quote, asked once", async () => {
    const quoted: string[] = [];
    setSharedRegistryForTests({
      marketData: createTestDataProvider({
        search: async () => [],
        getQuote: async (symbol) => {
          quoted.push(symbol);
          return createTestQuote({ symbol: "OMV.VI", listingExchangeName: "VIE", currency: "EUR", price: 47.1, name: "OMV AG" });
        },
      }),
    } as PluginRegistry);
    const validation = await resolveQuickAddValidation({
      query: "OMV.VI",
      collectionId: "watchlist",
      collectionKind: "watchlist",
      tickers: new Map(),
      financials: new Map(),
    });
    expect(validation).toMatchObject({ status: "ready", quote: { price: 47.1 } });
    expect(quoted).toEqual(["OMV.VI"]);
  });

  test("a bare symbol is its US listing though its listing abroad holds the bare key, and the two stay separate rows", async () => {
    const shell = (exchange: string, currency: string, name: string): InstrumentSearchResult => ({
      providerId: "test", symbol: "SHEL", name, exchange, currency, type: "STK",
    });
    setSharedRegistryForTests({
      marketData: createTestDataProvider({
        search: async () => [shell("LSE", "GBP", "Shell plc"), shell("NYSE", "USD", "Shell PLC ADR")],
        getQuote: async (_symbol, exchange) => createTestQuote({
          symbol: "SHEL", listingExchangeName: exchange === "LSE" ? "LSE" : "NYSE", currency: exchange === "LSE" ? "GBP" : "USD",
        }),
      }),
    } as PluginRegistry);
    // SHEL.L, added first, saved under the bare key.
    const london = createTestTicker("SHEL", "Shell plc", { exchange: "LSE", currency: "GBP", watchlists: ["watchlist"] });
    const validate = (tickers: Map<string, ReturnType<typeof createTestTicker>>) => resolveQuickAddValidation({
      query: "SHEL", collectionId: "watchlist", collectionKind: "watchlist", tickers, financials: new Map(),
    });
    const fresh = await validate(new Map());
    const known = await validate(new Map([["SHEL", london]]));
    for (const validation of [fresh, known]) {
      expect(validation.status).toBe("ready");
      if (validation.status !== "ready") return;
      expect(exchangeLabelFromValidation(validation)).toBe("NYSE");
    }
    // Once New York's line is saved beside it, the bare symbol is that row.
    const newYork = createTestTicker("SHEL:XNYS", "Shell PLC ADR", { exchange: "NYSE", currency: "USD", watchlists: ["watchlist"] });
    expect(await validate(new Map([["SHEL", london], ["SHEL:XNYS", newYork]]))).toMatchObject({ status: "duplicate", symbol: "SHEL:XNYS" });
  });

  // `a` then EURUSD=X said "Use a ticker symbol", and so did a pasted `usd/jpy, EUR/JPY ,gbp-chf`.
  test("the row takes every form quote and watchlist add take, and a pasted list entry by entry", async () => {
    for (const typed of ["EURUSD=X", "^GSPC", "CL=F", "SAN:EPA", "BRK.B", "BTC-USD", "EUR/USD", "M&M.NS"]) {
      expect(isPlausibleTickerQuery(normalizeQuickAddQuery(typed)), typed).toBe(true);
    }
    // What no symbol holds is refused naming what the row takes, with no lookup.
    expect(await resolveQuickAddValidation({ query: "!!!", collectionId: "watchlist", collectionKind: "watchlist", tickers: new Map(), financials: new Map() }))
      .toEqual({ status: "missing", query: "!!!", message: QUICK_ADD_REFUSAL });

    const searched: string[] = [];
    const listed: Record<string, InstrumentSearchResult> = Object.fromEntries(["USDJPY=X", "EURJPY=X", "GBPCHF=X", "EURUSD=X"].map((symbol) => [symbol, {
      providerId: "test", symbol, name: `${symbol.slice(0, 3)}/${symbol.slice(3, 6)}`, exchange: "CCY", currency: symbol.slice(3, 6), type: "CURRENCY",
    }]));
    setSharedRegistryForTests({
      marketData: createTestDataProvider({
        search: async (query) => {
          searched.push(query);
          const key = query.toUpperCase().replace(/[/-]/, "").replace(/(=X)?$/, "=X");
          return listed[key] ? [listed[key]!] : [];
        },
        getQuote: async (symbol) => createTestQuote({ symbol, price: 1.1, instrumentType: "CURRENCY" }),
      }),
    } as PluginRegistry);
    expect(mayBeQuickAddList("EURUSD=X")).toBe(false);
    expect((await readQuickAddEntries("usd/jpy, EUR/JPY ,gbp-chf")).entries).toEqual(["USD/JPY", "EUR/JPY", "GBP-CHF"]);
    // Symbols typed on one line are still a list of them.
    expect((await readQuickAddEntries("EURUSD=X USDJPY=X")).entries).toEqual(["EURUSD=X", "USDJPY=X"]);
    const collection = { collectionId: "watchlist", collectionKind: "watchlist" as const, tickers: new Map(), financials: new Map() };
    const list = await resolveQuickAddList({ ...collection, query: "USD/JPY, EUR/JPY, XYZQ", entries: ["USD/JPY", "EUR/JPY", "XYZQ"] });
    expect(list.status).toBe("list");
    if (list.status !== "list") return;
    expect(list.entries.map((entry) => [entry.query, entry.status])).toEqual([["USD/JPY", "ready"], ["EUR/JPY", "ready"], ["XYZQ", "missing"]]);
    // One entry is checked as a symbol typed alone.
    expect(await resolveQuickAddList({ ...collection, query: "EURUSD=X", entries: ["EURUSD=X"] })).toMatchObject({ status: "ready", symbol: "EURUSD=X" });
  });

  // "Apple Inc" over "Meta Platforms" was one line of four words, and `EURUSD=X, eur/usd` added EUR/USD twice.
  test("a pasted list keeps its lines and case, is each symbol once and at most fifty, and a keystroke looks up only what it changed", async () => {
    const names: Record<string, InstrumentSearchResult> = {
      "APPLE INC": { providerId: "test", symbol: "AAPL", name: "Apple Inc", exchange: "NASDAQ", currency: "USD", type: "STK" },
      "META PLATFORMS": { providerId: "test", symbol: "META", name: "Meta Platforms", exchange: "NASDAQ", currency: "USD", type: "STK" },
      "EURUSD=X": { providerId: "test", symbol: "EURUSD=X", name: "EUR/USD", exchange: "CCY", currency: "USD", type: "CURRENCY" },
      "EUR/USD": { providerId: "test", symbol: "EURUSD=X", name: "EUR/USD", exchange: "CCY", currency: "USD", type: "CURRENCY" },
    };
    const searched: string[] = [];
    setSharedRegistryForTests({
      marketData: createTestDataProvider({
        search: async (query) => {
          searched.push(query);
          const found = names[query.toUpperCase()];
          return found ? [found] : [];
        },
        getQuote: async (symbol) => createTestQuote({ symbol, price: 1.1 }),
      }),
    } as PluginRegistry);
    // The row joins a pasted column with ", ": each line one entry, a name read as one in the case it was typed.
    expect((await readQuickAddEntries("Apple Inc, Meta Platforms")).entries).toEqual(["APPLE INC", "META PLATFORMS"]);
    expect((await readQuickAddEntries("VOD LN, BARC LN")).entries).toEqual(["VOD LN", "BARC LN"]);

    const collection = { collectionId: "watchlist", collectionKind: "watchlist" as const, tickers: new Map(), financials: new Map() };
    const once = await resolveQuickAddList({ ...collection, query: "EURUSD=X, EUR/USD", entries: ["EURUSD=X", "EUR/USD"] });
    expect(once).toMatchObject({ status: "list", entries: [{ status: "ready", symbol: "EURUSD=X" }] });

    // Past fifty, the first fifty are read and the list says how many it held.
    const long = Array.from({ length: 73 }, (_, index) => `S${index}`).join(", ");
    const read = await readQuickAddEntries(long);
    expect(read.entries).toHaveLength(QUICK_ADD_LIST_MAX);
    expect(read.total).toBe(73);
    expect(await resolveQuickAddList({ ...collection, query: long, ...read })).toMatchObject({ status: "list", total: 73 });

    // Typing on after a paste looks up only the entry the keystroke changed.
    const memo = createQuickAddListMemo();
    const check = async (value: string) => {
      const { entries, total } = await readQuickAddEntries(value, memo);
      return resolveQuickAddList({ ...collection, query: value, entries, total, memo });
    };
    await check("Apple Inc, Meta Platforms, EURUSD=X");
    searched.length = 0;
    await check("Apple Inc, Meta Platforms, EURUSD=X, EUR/USD");
    expect(searched.every((query) => query.toUpperCase().includes("EUR/USD") || query.toUpperCase().includes("EURUSD"))).toBe(true);
    expect(searched.length).toBeGreaterThan(0);
  });
});
