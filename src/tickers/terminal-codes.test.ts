import { expect, test } from "bun:test";
import { applyListingArgument } from "../cli/pane-functions/resolver";
import { parsePaneFunctionArgs } from "../cli/pane-functions/options";
import type { PaneFunctionCatalog } from "../cli/pane-functions/catalog";
import type { MarketContext } from "../cli/types";
import { parseListingArg, resolveCliListing } from "../cli/listing-arg";
import { createTestDataProvider } from "../test-support/data-provider";
import type { InstrumentSearchResult } from "../types/instrument";
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

test("the shared resolver reads a code before a company name search, and fn takes one with spaces", async () => {
  const searched: string[] = [];
  const listed: Record<string, InstrumentSearchResult[]> = {
    JPM: [{ providerId: "test", symbol: "JPM", name: "JPMorgan Chase & Co.", exchange: "NYSE", currency: "USD", type: "Common Stock" }],
    GLOBAL: [{ providerId: "test", symbol: "GLOBAL", name: "Global Holdings", exchange: "JSE", currency: "ZAR", type: "Common Stock" }],
  };
  const fund: InstrumentSearchResult = { providerId: "test", symbol: "PUEQX", name: "Putnam US Equity Fund", exchange: "NASDAQ", currency: "USD", type: "Mutual Fund" };
  const dataProvider = createTestDataProvider({
    search: async (query) => { searched.push(query); return listed[query] ?? (/putnam/i.test(query) ? [fund] : []); },
  });
  const deps = { store: { loadTicker: async () => null, loadAllTickers: async () => [] }, dataProvider };
  expect(await resolveCliListing("JPM US Equity", undefined, deps)).toMatchObject({ key: "JPM", request: { symbol: "JPM", exchange: "" } });
  expect(await resolveCliListing("jpm us equity", undefined, deps)).toMatchObject({ key: "JPM" });
  expect(await resolveCliListing("WFC.N", undefined, deps))
    .toMatchObject({ key: "WFC:NYSE", request: { symbol: "WFC:NYSE", exchange: "NYSE" }, readAs: "Read WFC.N as WFC:NYSE." });
  // A Reuters code costs no search; a Bloomberg code asks for its root, never for the words as a name.
  expect(searched).toEqual(["JPM", "JPM"]);
  // Words whose root is no US ticker are a fund's name, or fail as the words they are, never PUTNAM or GLOBAL.
  expect(await resolveCliListing("Putnam US Equity", undefined, deps))
    .toMatchObject({ key: "PUEQX:NASDAQ", readAs: 'Read "Putnam US Equity" as PUEQX:NASDAQ (Putnam US Equity Fund).' });
  const global = await resolveCliListing("Global US Equity", undefined, deps).then((listing) => listing.key, (error: Error) => error.message);
  expect(global).not.toBe("GLOBAL");
  expect(global).not.toContain("Read");

  const pane: PaneDef = { id: "sec", name: "SEC", component: () => null, defaultPosition: "right" };
  const headless: HeadlessPaneDefinition<"rows"> = { shape: "rows", argument: { kind: "ticker" }, options: [], load: () => ({ rows: [] }) };
  const template: PaneTemplateDef = {
    id: "sec-pane", paneId: "sec", label: "SEC", description: "SEC", shortcut: { prefix: "SEC", argPlaceholder: "", argKind: "ticker" }, headless,
  };
  const registry: PaneFunctionCatalog = { panes: new Map([["sec", pane]]), paneTemplates: new Map([["sec-pane", template]]), destroy: () => {} };
  const resolve = async (arg: string) => (await applyListingArgument(registry, deps as unknown as MarketContext, parsePaneFunctionArgs(["SEC", arg]))).arg;
  expect(await resolve("JPM US Equity")).toBe("JPM");
  expect(await resolve("WFC.N")).toBe("WFC:NYSE");
  // A ticker argument with spaces that is no code stays as typed, as before.
  expect(await resolve("Global US Equity")).toBe("Global US Equity");
});
