import { expect, test } from "bun:test";
import { optionsPositioningHeadless } from "../../plugins/builtin/options-positioning/headless";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import type { PaneDef, PaneTemplateDef } from "../../types/plugin";
import type { MarketContext } from "../types";
import type { PaneFunctionCatalog } from "./catalog";
import { parsePaneFunctionArgs } from "./options";
import { applyListingArgument } from "./resolver";

const TYPES: Record<string, string> = { BTC: "ETF", SPY: "ETF", "BTC-USD": "CRYPTOCURRENCY", "SOL-USD": "CRYPTOCURRENCY" };
const pane: PaneDef = { id: "options-positioning", name: "OPX", component: () => null, defaultPosition: "right", tickerFollower: true };
const template: PaneTemplateDef = {
  id: "options-positioning-pane", paneId: "options-positioning", label: "OPX", description: "OPX",
  shortcut: { prefix: "OPX", argPlaceholder: "", argKind: "ticker" }, headless: optionsPositioningHeadless("strikes"),
};
const registry: PaneFunctionCatalog = { panes: new Map([[pane.id, pane]]), paneTemplates: new Map([[template.id, template]]), destroy: () => {} };
const market = {
  config: createDefaultConfig("/tmp/coin-options-alias-test"),
  store: { loadTicker: async () => null, loadAllTickers: async () => [] },
  dataProvider: createTestDataProvider({
    search: async () => [],
    getQuote: async (symbol) => createTestQuote({ symbol, instrumentType: TYPES[symbol] ?? "EQUITY" }),
  }),
} as unknown as MarketContext;

const resolve = (args: string[]) => applyListingArgument(registry, market, parsePaneFunctionArgs(args, {}));

test("fn OPX reads a bare BTC as the coin with a note, and --exchange keeps the fund", async () => {
  const coin = await resolve(["OPX", "BTC"]);
  expect(coin.arg).toBe("BTC-USD");
  expect(coin.listingNotes?.join("\n")).toContain("BTC read as BTC-USD, the coin's options. For the US fund that trades as BTC: gloomberb fn OPX BTC:ARCA");
  const fund = await resolve(["OPX", "BTC", "--exchange", "ARCA"]);
  expect(fund.arg).toBe("BTC:ARCA");
  expect(fund.listingNotes).toBeUndefined();
  // A listing that is not BTC or ETH, or BTC-USD itself, goes through as typed.
  expect((await resolve(["OPX", "SPY"])).arg).toBe("SPY");
  expect((await resolve(["OPX", "BTC-USD"])).arg).toBe("BTC-USD");
});

test("fn OPX answers a coin without options before any request, naming BTC and ETH options and IBIT", async () => {
  const error = await resolve(["OPX", "SOL-USD"]).then(() => null, (failure: Error & { details?: string }) => failure);
  expect(error?.message).toContain("SOL-USD");
  expect(error?.details).toContain("BTC-USD");
  expect(error?.details).toContain("fn OPX IBIT");
});
