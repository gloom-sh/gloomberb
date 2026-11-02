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
