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

test("OVDV, HIVG and VCA answer an FX pair or currency future in one line, before any request: OTC FX vol is not covered, the currency ETF to read instead and what it gives, its history, and HVT", async () => {
  // The fund gives an ATM IV30 and no wings: the line says so before it is followed to an empty skew.
  expect((await refusal("OVDV", "EURUSD=X"))?.message).toBe("OTC FX volatility is not covered for EURUSD=X. Currency-ETF options are the listed proxy and give "
    + "an ATM IV30 only, no 25-delta risk reversal or butterfly: FXE (gloom fn OVDV FXE, history gloom fn HIVG FXE). Realized volatility: gloom fn HVT EURUSD=X.");
  // A CME currency future has options at CME: the app does not serve them, and the fund is the proxy.
  expect((await refusal("OVDV", "6E=F"))?.message).toStartWith("Options on CME euro futures (6E=F) are not served. Currency-ETF options are the listed proxy");
  expect((await refusal("OVDV", "6J=F"))?.message).toContain("butterfly: FXY (gloom fn OVDV FXY, history gloom fn HIVG FXY). Realized volatility: gloom fn HVT 6J=F.");
  // HIVG is the history: it is not named twice.
  expect((await refusal("HIVG", "6J=F"))?.message).toContain("FXY (gloom fn HIVG FXY). Realized volatility: gloom fn HVT 6J=F.");
  // One line: nothing follows it.
  expect((await refusal("OVDV", "EURUSD=X"))?.details).toBeUndefined();
  // Every spelling of a pair is the pair; a pair no single-currency fund holds lists the funds, the dollar's first for OVDV.
  for (const typed of ["EUR/USD", "eurusd=x", "EURUSD"]) expect((await refusal("OVDV", typed))?.message, typed).toContain("for EURUSD=X.");
  expect((await refusal("OVDV", "USD/MXN"))?.message).toContain(": FXE, FXY, FXB, UUP (gloom fn OVDV UUP, history gloom fn HIVG UUP).");
  // A list screens the funds.
  expect((await refusal("VCA", "6C=F"))?.message).toContain("(gloom fn VCA FXE,FXY,FXB,UUP, history gloom fn HIVG UUP). Realized volatility: gloom fn HVT 6C=F.");
});

test("a list leaves an FX pair out with the same line as a note, and a US underlying or spot gold is not read as FX", async () => {
  const mixed = await resolve("VCA", "SPY,GBPUSD=X");
  expect(mixed.arg).toBe("SPY");
  expect(mixed.listingNotes?.join("\n")).toContain("OTC FX volatility is not covered for GBPUSD=X. Currency-ETF options are the listed proxy and give an ATM IV30 only, no 25-delta risk reversal or butterfly: FXB (gloom fn VCA FXB, history gloom fn HIVG FXB).");
  expect((await resolve("OVDV", "SPY")).arg).toBe("SPY");
  expect((await resolve("OVDV", "FXE")).arg).toBe("FXE");
  expect((await refusal("OVDV", "XAUUSD=X"))?.message ?? "").not.toContain("OTC FX volatility");
});
