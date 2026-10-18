import { expect, test } from "bun:test";
import { applyListingArgument } from "../cli/pane-functions/resolver";
import { parsePaneFunctionArgs } from "../cli/pane-functions/options";
import type { PaneFunctionCatalog } from "../cli/pane-functions/catalog";
import type { MarketContext } from "../cli/types";
import { parseListingArg, resolveCliListing } from "../cli/listing-arg";
import { createTestDataProvider } from "../test-support/data-provider";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../types/plugin";
import { normalizeTickerInput } from "./search";
import { readTerminalListingCode } from "./terminal-codes";

test.each([
  ["WFC.N", "WFC:NYSE"],
  ["wfc.n", "WFC:NYSE"],
  ["AAPL.O", "AAPL:NASDAQ"],
  ["AAPL.OQ", "AAPL:NASDAQ"],
  ["BRKb.N", "BRK.B:NYSE"],
  ["JPM US Equity", "JPM"],
  ["jpm  us  equity", "JPM"],
  ["JPM UN Equity", "JPM:NYSE"],
  ["BRK/B US Equity", "BRK.B"],
])("a terminal's code %s is the US listing %s", (typed, key) => {
  expect(readTerminalListingCode(typed)?.key).toBe(key);
  expect(parseListingArg(typed).key).toBe(key);
  expect(normalizeTickerInput(null, typed)).toBe(key);
});

test.each(["VOD.L", "7203.T", "RY.TO", "0700.HK", "BRK.B", "BRK.A", "VOD LN Equity", "JPM US", "Wells Fargo"])(
  "%s is not a terminal's code for a US listing and parses as before",
  (typed) => {
    expect(readTerminalListingCode(typed)).toBeNull();
    expect(parseListingArg(typed).readAs).toBeUndefined();
  },
);

test("the shared resolver reads the codes before a company name search, and fn takes one with spaces", async () => {
  const searched: string[] = [];
  const dataProvider = createTestDataProvider({ search: async (query) => { searched.push(query); return []; } });
  const deps = { store: { loadTicker: async () => null, loadAllTickers: async () => [] }, dataProvider };
  expect(await resolveCliListing("JPM US Equity", undefined, deps)).toMatchObject({ key: "JPM", request: { symbol: "JPM", exchange: "" } });
  expect(await resolveCliListing("WFC.N", undefined, deps))
    .toMatchObject({ key: "WFC:NYSE", request: { symbol: "WFC:NYSE", exchange: "NYSE" }, readAs: "Read WFC.N as WFC:NYSE." });
  expect(searched).toEqual([]);

  const pane: PaneDef = { id: "sec", name: "SEC", component: () => null, defaultPosition: "right" };
  const headless: HeadlessPaneDefinition<"rows"> = { shape: "rows", argument: { kind: "ticker" }, options: [], load: () => ({ rows: [] }) };
  const template: PaneTemplateDef = {
    id: "sec-pane", paneId: "sec", label: "SEC", description: "SEC", shortcut: { prefix: "SEC", argPlaceholder: "", argKind: "ticker" }, headless,
  };
  const registry: PaneFunctionCatalog = { panes: new Map([["sec", pane]]), paneTemplates: new Map([["sec-pane", template]]), destroy: () => {} };
  const resolved = await applyListingArgument(registry, deps as unknown as MarketContext, parsePaneFunctionArgs(["SEC", "JPM US Equity"]));
  expect(resolved.arg).toBe("JPM");
  expect((await applyListingArgument(registry, deps as unknown as MarketContext, parsePaneFunctionArgs(["SEC", "WFC.N"]))).arg).toBe("WFC:NYSE");
});
