import { expect, test } from "bun:test";
import { applyListingArgument } from "./pane-functions/resolver";
import { parsePaneFunctionArgs } from "./pane-functions/options";
import type { PaneFunctionCatalog } from "./pane-functions/catalog";
import type { MarketContext } from "./types";
import { resolveCliListing } from "./listing-arg";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../types/plugin";

// The venue each symbol's own quote names, as Gloom Cloud answers RY.TO.
const VENUES: Record<string, string> = { "RY.TO": "TSX", "7203.T": "JPX", "BRK.B": "NYSE" };

function insRegistry(): PaneFunctionCatalog {
  const pane: PaneDef = { id: "insider", name: "Insiders", component: () => null, defaultPosition: "right" };
  const headless: HeadlessPaneDefinition<"rows"> = { shape: "rows", argument: { kind: "ticker" }, options: [], load: () => ({ rows: [] }) };
  const template: PaneTemplateDef = {
    id: "insider-pane", paneId: "insider", label: "INS", description: "Insiders", shortcut: { prefix: "INS", argPlaceholder: "", argKind: "ticker" }, headless,
  };
  return { panes: new Map([["insider", pane]]), paneTemplates: new Map([["insider-pane", template]]), destroy: () => {} };
}

// GLO-1106: `fn INS RY.TO` answered "Unknown ticker RY.TO" while `quote RY.TO` worked: the SEC data is read by venue.
test("fn reads a venue suffix as the listing its quote names, as quote does, through the shared listing resolver", async () => {
  const quoted: string[] = [];
  const dataProvider = createTestDataProvider({
    getQuote: async (symbol) => {
      quoted.push(symbol);
      const venue = VENUES[symbol];
      if (!venue) throw new Error(`Unknown ticker ${symbol}`);
      return createTestQuote({ symbol, listingExchangeName: venue });
    },
  });
  const deps = { store: { loadTicker: async () => null, loadAllTickers: async () => [] }, dataProvider } as unknown as MarketContext;
  const resolve = (arg: string) => applyListingArgument(insRegistry(), deps, parsePaneFunctionArgs(["INS", arg]));

  const ry = await resolve("RY.TO");
  expect(ry.arg).toBe("RY:TSX");
  expect(ry.listing).toMatchObject({ symbol: "RY", exchange: "TSX", readAs: "Read RY.TO as RY:TSX.", request: { symbol: "RY:TSX", exchange: "TSX" } });
  expect((await resolve("7203.T")).arg).toBe("7203:JPX");
  // A US share class is quoted on its US venue and stays as typed; so does a suffix no quote answers.
  expect((await resolve("BRK.B")).arg).toBe("BRK.B");
  expect((await resolve("NOPE.TO")).arg).toBe("NOPE.TO");
  expect(quoted).toEqual(["RY.TO", "7203.T", "BRK.B", "NOPE.TO"]);

  // `quote` reads RY.TO as it always has, by its own quote, without the extra request.
  expect(await resolveCliListing("RY.TO", null, deps)).toMatchObject({ key: "RY.TO", exchange: "" });
  expect(quoted).toHaveLength(4);
});
