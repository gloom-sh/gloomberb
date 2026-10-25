import { expect, test } from "bun:test";
import { ivHistoryHeadless, ivScreenHeadless } from "../../plugins/builtin/iv-history/headless";
import { volSurfaceHeadless } from "../../plugins/builtin/vol-surface/headless";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../../types/plugin";
import type { MarketContext } from "../types";
import type { PaneFunctionCatalog } from "./catalog";
import { parsePaneFunctionArgs } from "./options";
import { applyListingArgument } from "./resolver";

const TYPES: Record<string, string> = { "EURUSD=X": "CURRENCY", "GBPUSD=X": "CURRENCY", "USDMXN=X": "CURRENCY", "6E=F": "FUTURE", "6J=F": "FUTURE", "6C=F": "FUTURE" };
const registryFor = (code: string, argKind: "ticker" | "ticker-list", headless: HeadlessPaneDefinition) => {
  const pane: PaneDef = { id: `${code}-pane`, name: code, component: () => null, defaultPosition: "right", tickerFollower: true };
  const template: PaneTemplateDef = {
    id: `${code}-template`, paneId: pane.id, label: code, description: code, shortcut: { prefix: code, argPlaceholder: "", argKind }, headless,
  };
  return { panes: new Map([[pane.id, pane]]), paneTemplates: new Map([[template.id, template]]), destroy: () => {} } as PaneFunctionCatalog;
};
const market = {
  config: createDefaultConfig("/tmp/fx-volatility-refusal-test"),
  store: { loadTicker: async () => null, loadAllTickers: async () => [] },
  dataProvider: createTestDataProvider({
    search: async () => [],
    getQuote: async (symbol) => createTestQuote({ symbol, instrumentType: TYPES[symbol] ?? "EQUITY" }),
  }),
} as unknown as MarketContext;

const registries = {
  OVDV: registryFor("OVDV", "ticker", volSurfaceHeadless as HeadlessPaneDefinition),
  HIVG: registryFor("HIVG", "ticker", ivHistoryHeadless as HeadlessPaneDefinition),
  VCA: registryFor("VCA", "ticker-list", ivScreenHeadless as HeadlessPaneDefinition),
};
const resolve = (code: keyof typeof registries, ...args: string[]) =>
  applyListingArgument(registries[code], market, parsePaneFunctionArgs([code, ...args], {}));
const refusal = (code: keyof typeof registries, ...args: string[]) =>
  resolve(code, ...args).then(() => null, (failure: Error & { details?: string }) => failure);

test("OVDV, HIVG and VCA answer an FX pair or currency future in one line, before any request: OTC FX vol is not covered, the currency ETF to read instead, and HVT", async () => {
  expect((await refusal("OVDV", "EURUSD=X"))?.message).toBe(
    "OTC FX volatility is not covered for EURUSD=X. Currency-ETF options are the listed proxy: FXE (gloom fn OVDV FXE). Realized volatility: gloom fn HVT EURUSD=X.");
  expect((await refusal("OVDV", "6E=F"))?.message).toBe(
    "OTC FX volatility is not covered for 6E=F. Currency-ETF options are the listed proxy: FXE (gloom fn OVDV FXE). Realized volatility: gloom fn HVT 6E=F.");
  expect((await refusal("HIVG", "6J=F"))?.message).toContain("FXY (gloom fn HIVG FXY). Realized volatility: gloom fn HVT 6J=F.");
  // One line: nothing follows it.
  expect((await refusal("OVDV", "EURUSD=X"))?.details).toBeUndefined();
  // Every spelling of a pair is the pair; a pair no single-currency fund holds lists the funds, the dollar's first for OVDV.
  for (const typed of ["EUR/USD", "eurusd=x", "EURUSD"]) expect((await refusal("OVDV", typed))?.message, typed).toContain("for EURUSD=X.");
  expect((await refusal("OVDV", "USD/MXN"))?.message).toContain("proxy: FXE, FXY, FXB, UUP (gloom fn OVDV UUP).");
  // A list screens the funds.
  expect((await refusal("VCA", "6C=F"))?.message).toContain("(gloom fn VCA FXE,FXY,FXB,UUP). Realized volatility: gloom fn HVT 6C=F.");
});

test("a list leaves an FX pair out with the same line as a note, and a US underlying or spot gold is not read as FX", async () => {
  const mixed = await resolve("VCA", "SPY,GBPUSD=X");
  expect(mixed.arg).toBe("SPY");
  expect(mixed.listingNotes?.join("\n")).toContain("OTC FX volatility is not covered for GBPUSD=X. Currency-ETF options are the listed proxy: FXB (gloom fn VCA FXB).");
  expect((await resolve("OVDV", "SPY")).arg).toBe("SPY");
  expect((await resolve("OVDV", "FXE")).arg).toBe("FXE");
  expect((await refusal("OVDV", "XAUUSD=X"))?.message ?? "").not.toContain("OTC FX volatility");
});
