import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { outage } from "../../../test-support/outage";
import { apiClient } from "../../../api-client";
import { reportCoverage, renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import type { DataProvider } from "../../../types/data-provider";
import { loadMarketMoverTab } from "./client";
import { createMarketMoversHeadless } from "./headless";
import { attachMarketMoversPersistence, resetMarketMoversPersistence } from "./screener";

const args = { rawArgument: "", argument: null, symbols: [], options: { list: "trending" } };
const observedAt = Date.parse("2026-10-20T14:00:00Z");
const quote = (symbol: string) => ({ symbol, price: 10, change: 0, changePercent: 0, currency: "USD", lastUpdated: observedAt });
const requested = ["FIRST", "SECOND", "THIRD", "SECOND"];
const unavailable = () => { throw new Error("Controlled quote failure"); };
afterEach(() => { jest.restoreAllMocks(); resetMarketMoversPersistence(); });

for (const scenario of ["batch rejection", "null batch entry", "omitted batch entry", "individual rejection", "no provider"] as const) {
  test(`trending reports requested names lost to ${scenario} instead of claiming complete coverage`, async () => {
    spyOn(apiClient, "getMarketTrending").mockResolvedValue({ status: "success", data: requested.map(symbol => ({ symbol })) });
    let provider: DataProvider | null = createTestDataProvider({
      getQuotesBatch: async targets => {
        if (scenario === "batch rejection") return unavailable();
        const found = targets.filter(target => target.symbol !== "SECOND").reverse().map(target => ({ target, quote: quote(target.symbol) }));
        return scenario === "null batch entry" ? [...found, { target: { symbol: "SECOND", exchange: "" }, quote: null, error: "Controlled quote failure" }] : found;
      },
      getQuote: async symbol => symbol === "SECOND" ? unavailable() : quote(symbol),
    });
    if (scenario === "individual rejection") provider.getQuotesBatch = undefined;
    if (scenario === "no provider") provider = null;
    const result = await loadMarketMoverTab("trending", provider);
    const total = scenario === "batch rejection" || scenario === "no provider";
    expect(result.quotes.map(row => [row.symbol, row.price, row.lastUpdated])).toEqual(total ? [] : [["FIRST", 10, observedAt], ["THIRD", 10, observedAt]]);
    expect(result).toMatchObject({ stale: true, unavailableSymbols: total ? ["FIRST", "SECOND", "THIRD"] : ["SECOND"] });
    const definition = createMarketMoversHeadless();
    const report = await definition.load(args, { marketData: provider } as any);
    expect(reportCoverage({ definition, result: report, args } as any)).toMatchObject({ complete: false, unavailableSymbols: result.unavailableSymbols });
    expect(serializeHeadlessPaneResult(definition, report).errors).toEqual(report.errors);
    expect(renderHeadlessPaneText(definition, report, args, "MOST")).toContain("Quotes unavailable:");
    expect(report.errors?.[0]).toContain("SECOND");
  });
}

test("healthy and genuinely empty trending responses remain complete", async () => {
  let symbols = ["FIRST", "SECOND"];
  spyOn(apiClient, "getMarketTrending").mockImplementation(async () => ({ status: "success", data: symbols.map(symbol => ({ symbol })) }));
  const batch = jest.fn(async (targets: Array<{ symbol: string; exchange: string }>) => targets.map(target => ({ target, quote: quote(target.symbol) })));
  const provider = createTestDataProvider({ getQuotesBatch: batch });
  const definition = createMarketMoversHeadless();
  const healthy = await definition.load(args, { marketData: provider } as any);
  expect(reportCoverage({ definition, result: healthy, args } as any).complete).toBe(true);
  expect(healthy.rows.map(row => row.symbol)).toEqual(symbols);
  expect(healthy.errors).toBeUndefined();
  symbols = [];
  const empty = await definition.load(args, { marketData: provider } as any);
  expect(empty.rows).toEqual([]);
  expect(reportCoverage({ definition, result: empty, args } as any).complete).toBe(true);
  expect(empty.errors).toBeUndefined();
});

test("a cached trending membership fallback remains stale after every quote hydrates", async () => {
  attachMarketMoversPersistence(new MemoryPluginPersistence());
  const response = spyOn(apiClient, "getMarketTrending").mockResolvedValue({ status: "success", data: [{ symbol: "FIRST" }] });
  const provider = createTestDataProvider({ getQuote: async symbol => quote(symbol) });
  expect((await loadMarketMoverTab("trending", provider)).stale).toBe(false);
  response.mockRejectedValue(outage("Controlled membership failure"));
  const cached = await loadMarketMoverTab("trending", provider, { forceRefresh: true });
  expect(cached).toMatchObject({ stale: true, quotes: [{ symbol: "FIRST", lastUpdated: observedAt }] });
  expect(cached.unavailableSymbols).toBeUndefined();
});
