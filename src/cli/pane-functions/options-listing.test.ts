import { expect, test } from "bun:test";
import { ivHistoryModule } from "../../plugins/builtin/iv-history";
import { optionsModule } from "../../plugins/builtin/options";
import { optionsPositioningModule } from "../../plugins/builtin/options-positioning";
import { optionsScenarioModule } from "../../plugins/builtin/options-scenario";
import { realizedVolModule } from "../../plugins/builtin/realized-vol";
import { realizedVolHeadless } from "../../plugins/builtin/realized-vol/headless";
import { volSurfaceModule } from "../../plugins/builtin/vol-surface";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../test-support/headless";
import { createTestTicker } from "../../test-support/ticker";
import { createDefaultConfig } from "../../types/config";
import { ListingArgError } from "../listing-arg";
import type { MarketContext } from "../types";
import type { PaneFunctionCatalog } from "./catalog";
import { parsePaneFunctionArgs } from "./options";
import { applyListingArgument } from "./resolver";

const modules = [ivHistoryModule, optionsModule, optionsPositioningModule, optionsScenarioModule, realizedVolModule, volSurfaceModule];
const panes = modules.flatMap((plugin) => plugin.panes ?? []);
const templates = modules.flatMap((plugin) => plugin.paneTemplates ?? []);
const registry: PaneFunctionCatalog = {
  panes: new Map(panes.map((pane) => [pane.id, pane])),
  paneTemplates: new Map(templates.map((template) => [template.id, template])),
  destroy: () => {},
};

const foreign = createTestQuote({ symbol: "PIRC", name: "Pirelli & C. S.p.A.", listingExchangeName: "BIT", currency: "EUR" });
const us = createTestQuote({ symbol: "AAPL", name: "Apple Inc.", listingExchangeName: "NASDAQ" });
const dataProvider = createTestDataProvider({
  knownUsStock: (symbol) => symbol === "AAPL",
  getQuote: async (key) => key.startsWith("PIRC") ? foreign : us,
});
const market = {
  config: createDefaultConfig("."), dataProvider,
  store: { loadTicker: async () => null, loadAllTickers: async () => [] },
} as unknown as MarketContext;

const apply = (code: string, key: string, context = market) => applyListingArgument(registry, context, parsePaneFunctionArgs([code, key]));

async function refusal(code: string, key: string, context = market) {
  try {
    await apply(code, key, context);
  } catch (error) {
    if (!(error instanceof ListingArgError)) throw error;
    return { message: error.message, details: error.details };
  }
  throw new Error(`${code} did not refuse ${key}`);
}

test.each(["HIVG", "VCA", "OVDV", "OPX", "GEX", "OSA", "CSP"])("%s refuses the foreign primary just like its named venue, but keeps US listings", async (code) => {
  const explicit = await refusal(code, "PIRC:BIT");
  expect(explicit.message).toContain("covers US listings only, and PIRC:BIT is Pirelli");
  expect(await refusal(code, "PIRC")).toEqual(explicit);
  expect((await apply(code, "AAPL")).arg).toBe("AAPL");
  expect((await apply(code, "AAPL:NASDAQ")).arg).toBe("AAPL:NASDAQ");
});

test("a foreign listing already saved without its venue in the key is still refused", async () => {
  const saved = createTestTicker("PIRC", foreign.name!, { exchange: "BIT", currency: "EUR" });
  const context = { ...market,
    store: { loadTicker: async (key) => key === "PIRC" ? saved : null, loadAllTickers: async () => [saved] } as MarketContext["store"],
  };
  expect(await refusal("HIVG", "PIRC", context)).toEqual(await refusal("HIVG", "PIRC:BIT", context));
});

test("OMON receives the same foreign routing in both spellings without rekeying a bare US stock", async () => {
  const explicit = await apply("OMON", "PIRC:BIT");
  expect((await apply("OMON", "PIRC")).listing?.request).toEqual(explicit.listing?.request);
  expect((await apply("OMON", "AAPL")).listing?.request).toEqual({ symbol: "AAPL", exchange: "" });
  expect((await apply("OMON", "AAPL:NASDAQ")).arg).toBe("AAPL:NASDAQ");
});

test.each(["HVT", "HVG"])("%s still shows foreign HV and only skips the IV request", async (code) => {
  const definition = realizedVolHeadless(code === "HVT" ? "cone" : "graph");
  let optionsRequests = 0;
  const bars = [{ date: new Date("2026-11-18T00:00:00Z"), close: 100 }];
  const ctx = createTestHeadlessContext({ marketData: { ...dataProvider,
    getPriceHistory: async () => bars, getPriceHistoryForResolution: async () => bars,
    getOptionsChain: async () => { optionsRequests += 1; throw new Error("Test chain unavailable"); },
  } });
  Object.assign(ctx.apiClient, { getCloudYieldCurve: async () => [] });
  for (const key of ["PIRC", "PIRC:BIT", "AAPL", "AAPL:NASDAQ"]) {
    const resolved = await apply(code, key);
    const result = await definition.load(createTestHeadlessArgs({ symbols: [resolved.arg], options: { windows: "20", showIv: true } }), ctx);
    expect(result.freshness?.asOf).toBe("2026-11-18");
    expect(result.metadata?.notices).toEqual(key.startsWith("PIRC")
      ? ["Options data covers US listings only, so PIRC:BIT has no current IV."] : undefined);
    if (key.startsWith("PIRC")) expect(optionsRequests).toBe(0);
  }
  expect(optionsRequests).toBe(2);
});
