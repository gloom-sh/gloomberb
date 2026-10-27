import { afterEach, expect, test } from "bun:test";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { setCliColorEnabledOverride } from "../../../utils/cli-output";
import type { CloudSessionMoverItem, CloudSessionMoversPayload } from "../../../api-client/market-movers";
import type { CloudMarketScreenerItem } from "../../../api-client/types";
import { loadMarketMoverTab, withMinFloat } from "./client";
import { createMarketMoversHeadless } from "./headless";
import { meetsMinFloat, minFloatFilter, minFloatShares, normalizeMinFloat } from "./min-float";
import { createRows } from "./model";
import { fetchPreferredMarketMovers, parseScreenerResponse, type ScreenerQuote } from "./screener";
import { buildSessionMoverColumns } from "./session-table";
import { buildMarketMoverColumns, renderMarketMoverCell } from "./table";

afterEach(() => setCliColorEnabledOverride(null));

const quote = (symbol: string, changePercent: number, floatShares?: number): ScreenerQuote => ({
  symbol, name: symbol, price: 10, change: changePercent / 10, changePercent, volume: 1_000_000, avgVolume: 500_000, volumeRatio: 2,
  marketCap: undefined, currency: "USD", fiftyTwoWeekHigh: undefined, fiftyTwoWeekLow: undefined, dayHigh: undefined, dayLow: undefined,
  exchange: "NASDAQ", ...(floatShares == null ? {} : { floatShares }),
});

test("a minimum float reads as shares; any, zero and words set none", () => {
  expect(["10M", "10m", "500k", "2.5M", "25000000", "1B", "10_000_000"].map(minFloatShares))
    .toEqual([10e6, 10e6, 500e3, 2.5e6, 25e6, 1e9, 10e6]);
  expect([null, "", "any", "ANY", "0", "ten"].map(minFloatShares)).toEqual([null, null, null, null, null, null]);
  expect(["10m", "25000000", "2.5M", "any", "0"].map(normalizeMinFloat)).toEqual(["10M", "25M", "2.5M", "any", "any"]);
  expect(() => normalizeMinFloat("-5M")).toThrow(/share count/);
  expect(() => normalizeMinFloat("10 shares")).toThrow(/share count/);
  // A row whose float is not known never passes a minimum.
  expect([meetsMinFloat(12e6, 10e6), meetsMinFloat(10e6, 10e6), meetsMinFloat(9e6, 10e6), meetsMinFloat(undefined, 10e6), meetsMinFloat(undefined, null)])
    .toEqual([true, true, false, false, true]);
});

test("the Min float menu offers the presets and keeps a minimum typed on the CLI", () => {
  const options = (value: string) => minFloatFilter(value, () => {}).options.map((option) => option.label);
  expect(options("any")).toEqual(["Any", "1M", "5M", "10M", "20M", "50M", "100M"]);
  expect(options("2.5M")).toEqual(["Any", "2.5M", "1M", "5M", "10M", "20M", "50M", "100M"]);
  expect(minFloatFilter("bogus", () => {}).value).toBe("any");
  expect(minFloatFilter("10M", () => {})).toMatchObject({ value: "10M", defaultValue: "any" });
});

test("the server's float is read from either list and kept off when it is not a positive count", async () => {
  expect(parseScreenerResponse({ quotes: [
    { symbol: "A", floatShares: 12_500_000 }, { symbol: "B", floatShares: 0 }, { symbol: "C", floatShares: "9" }, { symbol: "D" },
  ] }).map((row) => row.floatShares)).toEqual([12_500_000, undefined, undefined, undefined]);

  const item = (symbol: string, floatShares?: number) => ({
    rank: 1, symbol, name: symbol, price: 10, change: 1, changePercent: 10, volume: 1, currency: "USD", exchange: "NASDAQ", lastUpdated: 1, dataSource: "live",
    ...(floatShares == null ? {} : { floatShares }),
  }) as CloudMarketScreenerItem;
  const result = await fetchPreferredMarketMovers("day_gainers", 25, { metadataWaitMs: 50 }, {
    isCloudEligible: () => true,
    fetchCloud: async () => ({ status: "success", data: { providerId: "gloomberb-cloud", category: "gainers", asOf: "", items: [item("LIVE", 30e6), item("META")] } }) as never,
    fetchMarket: async () => ({ data: [quote("META", 5, 8e6)], stale: false }),
  });
  // The live list's own float first, the delayed list's when it sends none.
  expect(result.quotes.map((row) => [row.symbol, row.floatShares])).toEqual([["LIVE", 30e6], ["META", 8e6]]);
});

test("Gainers keep the rows at or above the minimum and Most Active reads more candidates for it", async () => {
  const asked: number[] = [];
  const list = [quote("TINY", 40, 2e6), quote("NONE", 30), quote("MID", 20, 15e6), quote("BIG", 10, 400e6)];
  const dependencies = {
    fetchPreferred: async (_category: string, count: number) => {
      asked.push(count);
      return { quotes: list, source: "gloom" as const, stale: false };
    },
    fetchTrending: async () => { throw new Error("unused"); },
  };
  const gainers = await loadMarketMoverTab("gainers", null, { minFloat: 10e6 }, dependencies);
  expect(gainers.quotes.map((row) => row.symbol)).toEqual(["MID", "BIG"]);
  expect(createRows(gainers.quotes).map((row) => row.rank)).toEqual([1, 2]);
  expect((await loadMarketMoverTab("gainers", null, {}, dependencies)).quotes).toHaveLength(4);
  await loadMarketMoverTab("actives", null, {}, dependencies);
  await loadMarketMoverTab("actives", null, { minFloat: 10e6 }, dependencies);
  expect(asked).toEqual([50, 50, 25, 50]);
});

test("without a minimum float every list is the list it was: the same rows, order and request, floats or not", async () => {
  const asked: number[] = [];
  // More rows than a list shows, some with a float, some without; losers fall.
  const listFor = (sign: number) => Array.from({ length: 30 }, (_, index) => quote(`S${index}`, sign * (40 - index), index % 3 ? (index + 1) * 1e6 : undefined));
  const bare = (quotes: ScreenerQuote[]) => quotes.map(({ floatShares: _, ...row }) => row as ScreenerQuote);
  const dependencies = (quotes: ScreenerQuote[]) => ({
    fetchPreferred: async (_category: string, count: number) => {
      asked.push(count);
      return { quotes, source: "gloom" as const, stale: false };
    },
    fetchTrending: async () => { throw new Error("unused"); },
  });
  for (const tab of ["gainers", "losers", "actives"] as const) {
    const list = listFor(tab === "losers" ? -1 : 1);
    const withFloats = await loadMarketMoverTab(tab, null, {}, dependencies(list));
    const without = await loadMarketMoverTab(tab, null, { minFloat: null }, dependencies(bare(list)));
    expect(withFloats.quotes).toHaveLength(25);
    expect(withFloats.quotes.map((row) => row.symbol)).toEqual(without.quotes.map((row) => row.symbol));
    expect(createRows(withFloats.quotes).map((row) => [row.symbol, row.rank])).toEqual(createRows(without.quotes).map((row) => [row.symbol, row.rank]));
  }
  // The counts the lists asked for before a minimum existed: 50 candidates for a price list, 25 for Most Active.
  expect(asked).toEqual([50, 50, 50, 50, 25, 25]);
  // No FLOAT column without a minimum.
  expect(buildMarketMoverColumns(100, []).map((column) => column.id)).not.toContain("floatShares");
});

test("a session list keeps the rows at or above the minimum, ranked again from 1", () => {
  const item = (symbol: string, rank: number, floatShares: number | null) => ({ symbol, rank, floatShares }) as Pick<CloudSessionMoverItem, "symbol" | "rank" | "floatShares">;
  expect(withMinFloat([item("A", 1, 1e6), item("B", 2, null), item("C", 3, 20e6), item("D", 4, 10e6)], 10e6))
    .toEqual([item("C", 1, 20e6), item("D", 2, 10e6)]);
});

test("FLOAT joins the lists while a minimum is set, and stays when a narrow pane drops MCAP", () => {
  const ids = (width: number, float: boolean) => buildMarketMoverColumns(width, [], { float }).map((column) => column.id);
  expect(ids(100, false)).not.toContain("floatShares");
  expect(ids(100, true)).toEqual(["rank", "symbol", "name", "price", "changePercent", "volume", "volumeRatio", "range", "marketCap", "floatShares"]);
  expect(ids(80, true)).toContain("floatShares");
  expect(ids(80, true)).not.toContain("marketCap");
  const [row] = createRows([quote("MID", 20, 15_250_000)]);
  const column = buildMarketMoverColumns(100, [], { float: true }).find((entry) => entry.id === "floatShares")!;
  expect(renderMarketMoverCell(row!, column).text).toBe("15.25M");

  const session = (width: number, float: boolean) => buildSessionMoverColumns("premarket", width, { float }).map((column) => column.id);
  expect(session(60, false)).not.toContain("floatShares");
  expect(session(60, true)).toContain("floatShares");
});

test("fn MOST --min-float filters every list that carries a float and says Trending carries none", async () => {
  const minimums: Array<number | null> = [];
  const sessionItem = (symbol: string, rank: number, floatShares: number | null) => ({ symbol, rank, floatShares, catalysts: [] }) as unknown as CloudSessionMoverItem;
  const headless = createMarketMoversHeadless({
    load: async (_args, tab, _provider, minFloat) => {
      minimums.push(minFloat);
      return { tab, quotes: tab === "trending" ? [quote("HOT", 5)] : [quote("MID", 20, 15e6)], source: "gloom", stale: false };
    },
    loadSession: async (_view, _side, minFloat) => {
      minimums.push(minFloat);
      return { session: "2026-10-09", phase: "pre", asOf: "2026-10-09T12:00:00Z", items: withMinFloat([sessionItem("LOW", 1, 1e6), sessionItem("OK", 2, 30e6)], minFloat!) } as unknown as CloudSessionMoversPayload;
    },
  });
  const option = headless.options!.find((entry) => entry.key === "min-float")!;
  expect(option).toMatchObject({ type: "string", pluginState: { pluginId: "market-overview", key: "minFloat" } });
  expect(option.normalize!("10m")).toBe("10M");

  setCliColorEnabledOverride(false);
  const context = { marketData: createTestDataProvider() } as never;
  const gainersArgs = { rawArgument: "", argument: null, symbols: [], options: { list: "gainers", "min-float": "10M" } };
  const gainers = await headless.load(gainersArgs, context);
  expect(gainers.metadata).toMatchObject({ minFloat: 10e6 });
  expect(renderHeadlessPaneText(headless, gainers, gainersArgs, "MOST")).toMatch(/Float[\s\S]*MID[^\n]*15\.00M/);

  const sessionArgs = { rawArgument: "", argument: null, symbols: [], options: { list: "premarket", side: "up", "min-float": "10M" } };
  const premarket = await headless.load(sessionArgs, context);
  expect(premarket.rows.map((row) => [row.symbol, row.rank])).toEqual([["OK", 1]]);

  const trendingArgs = { rawArgument: "", argument: null, symbols: [], options: { list: "trending", "min-float": "10M" } };
  const trending = await headless.load(trendingArgs, context);
  expect(trending.rows.map((row) => row.symbol)).toEqual(["HOT"]);
  expect(trending.notes).toEqual(["Trending carries no float, so --min-float does not apply to it."]);
  expect(minimums).toEqual([10e6, 10e6, null]);
});
