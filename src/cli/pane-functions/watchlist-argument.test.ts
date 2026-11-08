import { expect, test } from "bun:test";
import { shortWatchHeadless } from "../../plugins/builtin/short-interest/watch-headless";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createTestTicker } from "../../test-support/ticker";
import { createDefaultConfig } from "../../types/config";
import type { PaneDef, PaneTemplateDef } from "../../types/plugin";
import type { MarketContext } from "../types";
import type { PaneFunctionCatalog } from "./catalog";
import { parsePaneFunctionArgs } from "./options";
import { applyListingArgument } from "./resolver";

const pane: PaneDef = { id: "short-watch", name: "SIW", component: () => null, defaultPosition: "right" };
const template: PaneTemplateDef = {
  id: "short-watch-pane", paneId: "short-watch", label: "Short Squeeze Watch", description: "SIW",
  shortcut: { prefix: "SIW", argKind: "ticker-list", argOptional: true }, headless: shortWatchHeadless,
};
const registry: PaneFunctionCatalog = { panes: new Map([[pane.id, pane]]), paneTemplates: new Map([[template.id, template]]), destroy: () => {} };

function market(members: number) {
  const symbols = Array.from({ length: members }, (_, index) => `HY${index}`);
  const saved = symbols.map((ticker) => createTestTicker(ticker, ticker, { watchlists: ["hy3"] }));
  return {
    config: { ...createDefaultConfig("/tmp/watchlist-argument-test"), watchlists: [{ id: "hy3", name: "HY3" }] },
    store: { loadTicker: async (symbol: string) => saved.find((ticker) => ticker.metadata.ticker === symbol) ?? null, loadAllTickers: async () => saved },
    dataProvider: createTestDataProvider({ search: async () => [], getQuote: async (symbol) => createTestQuote({ symbol }) }),
  } as unknown as MarketContext;
}

test("a list function given a watchlist's name reads its symbols, at most the function's maximum, saying so", async () => {
  // 2 Nov 2026: `fn SIW HY3` answered "Not a ticker: HY3" after 12 s.
  const three = await applyListingArgument(registry, market(3), parsePaneFunctionArgs(["SIW", "hy3"], {}));
  expect(three.arg).toBe("HY0, HY1, HY2");
  // The note says the name was read as the watchlist, which matters when a ticker has that name too.
  expect(three.listingNotes).toEqual(["Read hy3 as watchlist HY3 (3 symbols)."]);
  const many = await applyListingArgument(registry, market(70), parsePaneFunctionArgs(["SIW", "HY3"], {}));
  expect(many.arg?.split(", ").length).toBe(60);
  expect(many.listingNotes?.[0]).toBe("Read HY3 as watchlist HY3 (70 symbols); the first 60 are read.");
});

test("a watchlist's listings abroad are read with their venue, so they are not the US lines of the same symbols", async () => {
  // `fn RV Watchlist --csv` printed ASML and 2330, where typed symbols read ASML:AMS and 2330:TWSE.
  const saved = [
    createTestTicker("NVDA", "NVIDIA", { watchlists: ["semis"] }),
    createTestTicker("ASML", "ASML Holding", { exchange: "AMS", currency: "EUR", watchlists: ["semis"] }),
    createTestTicker("2330", "TSMC", { exchange: "TWSE", currency: "TWD", watchlists: ["semis"] }),
    createTestTicker("ES=F", "E-mini S&P 500", { exchange: "CME", watchlists: ["semis"] }),
  ];
  const context = {
    config: { ...createDefaultConfig("/tmp/watchlist-argument-test"), watchlists: [{ id: "semis", name: "Semis" }] },
    store: { loadTicker: async (symbol: string) => saved.find((ticker) => ticker.metadata.ticker === symbol) ?? null, loadAllTickers: async () => saved },
    dataProvider: createTestDataProvider({ search: async () => [], getQuote: async (symbol) => createTestQuote({ symbol }) }),
  } as unknown as MarketContext;
  // A list function that reads listings abroad too, as RV does.
  const anyListing: PaneTemplateDef = { ...template, headless: { ...shortWatchHeadless, usListingsOnly: undefined } };
  const catalog: PaneFunctionCatalog = { ...registry, paneTemplates: new Map([[anyListing.id, anyListing]]) };
  const read = await applyListingArgument(catalog, context, parsePaneFunctionArgs(["SIW", "Semis"], {}));
  expect(read.arg?.split(", ")).toEqual(["NVDA", "ASML:AMS", "2330:TWSE", "ES=F"]);
});
