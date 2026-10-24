import { expect, test } from "bun:test";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import { createDefaultConfig } from "../types/config";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../types/plugin";
import type { PaneFunctionCatalog } from "./pane-functions/catalog";
import { parsePaneFunctionArgs } from "./pane-functions/options";
import { applyListingArgument } from "./pane-functions/resolver";
import type { MarketContext } from "./types";

const TYPES: Record<string, string> = { AAPL: "EQUITY", VOO: "ETF", VFIAX: "MUTUALFUND", "^VIX": "INDEX", "^GSPC": "INDEX", "^MOVE": "INDEX" };
const companyPane = (id: string): PaneDef => ({ id, name: id, component: () => null, defaultPosition: "right", tickerFollower: true, instruments: ["equity"] });
const report = (kind: "ticker" | "tickers"): HeadlessPaneDefinition<"bundle"> => ({
  shape: "bundle", argument: { kind }, options: [], load: () => ({ sections: [] }),
});
const template = (prefix: string, paneId: string, kind: "ticker" | "tickers"): PaneTemplateDef => ({
  id: `${paneId}-pane`, paneId, label: prefix, description: prefix, shortcut: { prefix, argPlaceholder: "", argKind: kind }, headless: report(kind),
});
const registry: PaneFunctionCatalog = {
  panes: new Map([["insider", companyPane("insider")], ["peers", companyPane("peers")]]),
  paneTemplates: new Map([["insider-pane", template("INS", "insider", "ticker")], ["peers-pane", template("PEERS", "peers", "tickers")]]),
  destroy: () => {},
};
const market = {
  config: createDefaultConfig("/tmp/uncovered-instrument-test"),
  store: { loadTicker: async () => null, loadAllTickers: async () => [] },
  dataProvider: createTestDataProvider({
    search: async () => [],
    getQuote: async (symbol) => createTestQuote({ symbol, instrumentType: TYPES[symbol] }),
  }),
} as unknown as MarketContext;

const refusal = (args: string[]) => applyListingArgument(registry, market, parsePaneFunctionArgs(args, {}))
  .then(() => null, (error: Error & { details?: string }) => `${error.message}\n${error.details}`);

test("a company function answers an index or a fund with what it is and a command that reads it, before any request", async () => {
  expect(await refusal(["INS", "^VIX"])).toBe("INS covers companies only, and ^VIX is an index.\nTry: gloom fn VIX");
  expect(await refusal(["INS", "^MOVE"])).toBe("INS covers companies only, and ^MOVE is an index.\nTry: gloom fn VIX");
  expect(await refusal(["INS", "^GSPC"])).toBe("INS covers companies only, and ^GSPC is an index.\nTry: gloom ticker ^GSPC");
  expect(await refusal(["INS", "VOO"])).toBe("INS covers companies only, and VOO is an ETF.\nTry: gloom fundamentals VOO");
  expect(await refusal(["INS", "VFIAX"])).toBe("INS covers companies only, and VFIAX is a mutual fund.\nTry: gloom fundamentals VFIAX");
  // A pair is one by its symbol, with no quote asked.
  expect(await refusal(["INS", "EURUSD=X"])).toBe("INS covers companies only, and EURUSD=X is a currency pair.\nTry: gloom ticker EURUSD=X");
  expect(await refusal(["INS", "AAPL"])).toBeNull();
});

test("a list leaves the index out with the same answer and keeps the companies", async () => {
  const parsed = await applyListingArgument(registry, market, parsePaneFunctionArgs(["PEERS", "AAPL,^VIX"], {}));
  expect(parsed.arg).toBe("AAPL");
  expect(parsed.listingNotes).toContain("PEERS covers companies only, and ^VIX is an index. Try: gloom fn VIX");
});
