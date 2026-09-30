import { afterEach, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createMarketMoversHeadless } from "./headless";
import { loadMarketMoverTab } from "./client";
import { createRows, sortRows } from "./model";
import { attachMarketMoversPersistence, fetchPreferredMarketMovers, fetchScreenerResult, parseScreenerResponse, resetMarketMoversPersistence } from "./screener";

const payload = (quotes: unknown[]) => ({ finance: { result: [{ quotes }], error: null } });
const raw = (symbol: string, fields = {}) => ({ symbol, regularMarketPrice: 10, currency: "USD", ...fields });
const noSessionMovers = async (): Promise<never> => { throw new Error("Session movers are not requested"); };
afterEach(resetMarketMoversPersistence);

test("source fields, sorted rows and headless text preserve missing versus reported zero", async () => {
  const rows = parseScreenerResponse(payload([
    raw("MISSING", { regularMarketVolume: "100", regularMarketChangePercent: null, currency: undefined }),
    raw("ZERO", { regularMarketVolume: 0, averageDailyVolume3Month: 100, regularMarketChangePercent: 0 }),
    raw("NEGATIVE", { regularMarketVolume: -1, regularMarketChangePercent: -5 }),
  ]));
  expect(rows[0]).toMatchObject({ volume: null, changePercent: null, avgVolume: null, volumeRatio: null, currency: "" });
  expect(rows[1]).toMatchObject({ volume: 0, changePercent: 0, volumeRatio: 0 });
  expect(rows[2]).toMatchObject({ volume: null, changePercent: -5 });
  expect(sortRows(createRows(rows), { columnId: "changePercent", direction: "asc" }).map(row => row.symbol)).toEqual(["NEGATIVE", "ZERO", "MISSING"]);
  expect(sortRows(createRows(rows), { columnId: "changePercent", direction: "desc" }).map(row => row.symbol)).toEqual(["ZERO", "NEGATIVE", "MISSING"]);
  const definition = createMarketMoversHeadless({ load: async (_args, tab) => ({ tab, quotes: rows, source: "yahoo", stale: false }), loadSession: noSessionMovers });
  const args = { rawArgument: "", argument: null, symbols: [], options: { list: "gainers" } };
  const result = await definition.load(args, { marketData: createTestDataProvider() } as any);
  const text = renderHeadlessPaneText(definition, result, args, "MOST");
  const missing = text.split("\n").find(line => line.includes("MISSING"))!;
  expect(missing).not.toContain("$");
  expect(missing).not.toContain("0.00%");
  expect(text.split("\n").find(line => line.includes("ZERO"))).toContain("0.00%");
});

test("malformed refresh retains cache with failure until valid recovery; empty and other keys remain independent", async () => {
  const persistence = new MemoryPluginPersistence();
  attachMarketMoversPersistence(persistence);
  let answer: unknown = payload([raw("VALID")]);
  const api = { fetchJson: async <T>() => answer as T };
  const first = await fetchScreenerResult("day_gainers", 25, api, { cache: true });
  const record = persistence.getResource("yahoo-screener", "screener:day_gainers:count=25", { sourceKey: "yahoo-finance", schemaVersion: 2 })!;
  answer = { finance: { result: null, error: { code: "Unavailable" } } };
  expect(await fetchScreenerResult("day_gainers", 25, api, { cache: true, forceRefresh: true })).toEqual({ data: first.data, stale: true });
  expect(await fetchScreenerResult("day_gainers", 25, api, { cache: true })).toEqual({ data: first.data, stale: true });
  expect(persistence.getResource("yahoo-screener", "screener:day_gainers:count=25", { sourceKey: "yahoo-finance", schemaVersion: 2 })?.fetchedAt).toBe(record.fetchedAt);
  await expect(fetchScreenerResult("day_losers", 25, api, { cache: true })).rejects.toThrow("Invalid market movers");
  answer = payload([]);
  expect(await fetchScreenerResult("day_losers", 25, api, { cache: true })).toEqual({ data: [], stale: false });
  expect(await fetchScreenerResult("day_gainers", 25, api, { cache: true })).toEqual({ data: [], stale: false });
  answer = { error: "must not refetch a fresh recovered cache" };
  expect(await fetchScreenerResult("day_gainers", 25, api, { cache: true })).toEqual({ data: [], stale: false });
});

test("old persisted fabricated zeros are discarded; newly validated hydrated rows remain readable", async () => {
  const persistence = new MemoryPluginPersistence();
  attachMarketMoversPersistence(persistence);
  const old = parseScreenerResponse(payload([raw("OLD", { regularMarketVolume: 0 })]));
  persistence.seedResource("yahoo-screener", "screener:day_gainers:count=25", old, { sourceKey: "yahoo-finance", schemaVersion: 1 });
  let calls = 0;
  const api = { fetchJson: async <T>() => { calls++; return payload([raw("CURRENT")]) as T; } };
  const result = await fetchScreenerResult("day_gainers", 25, api, { cache: true });
  expect(result.data[0]).toMatchObject({ symbol: "CURRENT", volume: null });
  resetMarketMoversPersistence(); attachMarketMoversPersistence(persistence);
  expect(await fetchScreenerResult("day_gainers", 25, api, { cache: true })).toEqual(result);
  expect(calls).toBe(1);
});

test("trending has no average-volume source, and missing quotes do not invent zero volume or ratios", async () => {
  const provider = createTestDataProvider({ getQuotesBatch: async targets => targets.map(target => ({ target, quote: {
    symbol: target.symbol, price: 10, currency: "USD", change: 0, changePercent: 0,
    lastUpdated: Date.now(), ...(target.symbol === "ZERO" ? { volume: 0 } : {}),
  } })) });
  const result = await loadMarketMoverTab("trending", provider, undefined, {
    fetchPreferred: async () => { throw new Error("unused"); },
    fetchTrending: async () => [{ symbol: "MISSING" }, { symbol: "ZERO" }],
  });
  expect(result.quotes.map(row => [row.symbol, row.volume, row.avgVolume, row.volumeRatio])).toEqual([["MISSING", null, null, null], ["ZERO", 0, null, null]]);
});

test("declared minor currencies normalize only display, without changing raw rows or assuming venue units", async () => {
  const rows = parseScreenerResponse(payload(["GBp", "GBX", "ILA", "ZAc", "GBP", ""].map((currency, index) => raw(`UNIT${index}`, { regularMarketPrice: 125, currency, fullExchangeName: "LSE" }))));
  const definition = createMarketMoversHeadless({ load: async (_args, tab) => ({ tab, quotes: rows, source: "yahoo", stale: false }), loadSession: noSessionMovers });
  const args = { rawArgument: "", argument: null, symbols: [], options: { list: "gainers" } };
  const result = await definition.load(args, { marketData: createTestDataProvider() } as any);
  expect(result.rows.map(row => [row.price, row.currency])).toEqual([[125, "GBp"], [125, "GBX"], [125, "ILA"], [125, "ZAc"], [125, "GBP"], [125, ""]]);
  const text = renderHeadlessPaneText(definition, result, args, "MOST");
  expect(text.split("\n").find(line => line.includes("UNIT0"))).toContain("£1.25");
  expect(text.split("\n").find(line => line.includes("UNIT1"))).toContain("£1.25");
  expect(text.split("\n").find(line => line.includes("UNIT2"))).toContain("1.25");
  expect(text.split("\n").find(line => line.includes("UNIT3"))).toContain("1.25");
  expect(text.split("\n").find(line => line.includes("UNIT4"))).toContain("£125.00");
  expect(text.split("\n").find(line => line.includes("UNIT5"))).not.toContain("$");
});


test("preferred Cloud prices qualify Yahoo range units before default headless projection", async () => {
  const metadata = parseScreenerResponse(payload([raw("UNIT", { regularMarketPrice: 125, currency: "GBp", fiftyTwoWeekLow: 100, fiftyTwoWeekHigh: 200, regularMarketDayLow: 110, regularMarketDayHigh: 150 })]));
  const load = async (currency: string, ownBounds = false) => {
    const result = await fetchPreferredMarketMovers("day_gainers", 25, undefined, {
      isCloudEligible: () => true,
      fetchCloud: async () => ({ status: "success", data: { items: [{ symbol: "UNIT", price: 1.25, change: 0, changePercent: 0, volume: 0, currency, exchange: "LSE", ...(ownBounds ? { low52w: 1, high52w: 2 } : {}) }] } } as any),
      fetchYahoo: async () => ({ data: metadata, stale: false }),
    });
    const definition = createMarketMoversHeadless({ load: async (_args, tab) => ({ ...result, tab }), loadSession: noSessionMovers });
    const args = { rawArgument: "", argument: null, symbols: [], options: { list: "gainers" } };
    const model = await definition.load(args, { marketData: createTestDataProvider() } as any);
    return { model, text: renderHeadlessPaneText(definition, model, args, "MOST") };
  };
  const converted = await load("GBP");
  expect(converted.model.rows[0]).toMatchObject({ price: 1.25, currency: "GBP", fiftyTwoWeekLow: 1, fiftyTwoWeekHigh: 2, dayLow: 1.1, dayHigh: 1.5, rangePositionPercent: 25 });
  expect(converted.text).toContain("£1.25");
  expect((await load("GBP", true)).model.rows[0]!.rangePositionPercent).toBe(25);
  for (const currency of ["", "USD"]) {
    const unknown = await load(currency);
    expect(unknown.model.rows[0]).toMatchObject({ price: 1.25, currency, rangePositionPercent: null });
    expect(unknown.model.rows[0]!.fiftyTwoWeekLow).toBeUndefined();
    expect(unknown.text).not.toContain("£");
  }
});
