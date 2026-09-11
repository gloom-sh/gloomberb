import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { PaneTemplateCreateOptions, PaneTemplateDef } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { CommandBarHarness, createCommandBarTestControls, emitKeypress, makeTicker } from "./test-harness";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => { await act(async () => { setup?.renderer.destroy(); }); setup = undefined; });
const { waitForFrameToContain } = createCommandBarTestControls(() => setup!);

for (const savedDefault of [false, true]) {
  test(`EE listing choice preserves TSX identity with ${savedDefault ? "a saved Nasdaq default" : "an unavailable default quote"}`, async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];
    const searchQueries: string[] = [];
    setup = await testRender(<CommandBarHarness
      query="EE SHOP"
      live
      extraTickers={savedDefault ? [makeTicker("SHOP", "Shopify Inc.")] : []}
      dataProvider={createTestDataProvider({
        search: async (query) => {
          searchQueries.push(query);
          return [
            { providerId: "test", symbol: "SHOP", name: "Shopify Inc.", exchange: "NASDAQ", currency: "USD", type: "EQUITY" },
            { providerId: "test", symbol: "SHOP", name: "Shopify Inc.", exchange: "TSX", currency: "CAD", type: "EQUITY" },
          ];
        },
        getQuote: async () => { throw new Error("Default quote unavailable"); },
      })}
      configurePluginRegistry={(registry) => {
        (registry.paneTemplates as Map<string, PaneTemplateDef>).set("earnings-estimates", {
          id: "earnings-estimates", paneId: "quote-monitor", label: "Earnings Estimates",
          description: "Research earnings estimates", shortcut: { prefix: "EE", argKind: "ticker" },
        });
        registry.createPaneFromTemplateAsyncFn = async (templateId, options) => { created.push({ templateId, options }); };
      }}
    />, { width: 100, height: 24 });
    await setup.renderOnce();
    // Enter must resolve an ambiguity; Tab deliberately selects another listing
    // even when a saved default could be opened without prompting.
    await emitKeypress(setup, savedDefault ? { name: "tab" } : { name: "return", sequence: "\r" });
    await waitForFrameToContain("TSX");
    await emitKeypress(setup, { name: "down" });
    const queriesBeforeChoice = searchQueries.length;
    await emitKeypress(setup, { name: "return", sequence: "\r", shift: savedDefault });
    await act(async () => { await Bun.sleep(20); });
    await setup.renderOnce();
    expect(created).toHaveLength(1);
    expect(created[0]?.templateId).toBe("earnings-estimates");
    expect(created[0]?.options?.symbol).toBe("SHOP:XTSE");
    expect(created[0]?.options?.ticker?.metadata).toMatchObject({ ticker: "SHOP:XTSE", exchange: "TSX", currency: "CAD" });
    expect(searchQueries).toHaveLength(queriesBeforeChoice);
    expect(setup.captureCharFrame()).toContain("Search or run a command");
  });
}

test("watchlist listing selection consumes the chosen record without re-searching its bare symbol", async () => {
  const saved: TickerRecord[] = [];
  let rejectFurtherSearch = false;
  setup = await testRender(<CommandBarHarness
    query="AW SHOP" live onSaveTicker={(ticker) => saved.push(ticker)}
    configureState={(state) => ({ ...state, paneState: { "portfolio-list:main": { collectionId: "watchlist" } } })}
    dataProvider={createTestDataProvider({
      search: async () => {
        if (rejectFurtherSearch) throw new Error("Search is no longer available");
        return [
          { providerId: "test", symbol: "SHOP", name: "Shopify Inc.", exchange: "NASDAQ", currency: "USD", type: "EQUITY" },
          { providerId: "test", symbol: "SHOP", name: "Shopify Inc.", exchange: "TSX", currency: "CAD", type: "EQUITY" },
        ];
      },
    })}
  />, { width: 100, height: 24 });
  await setup.renderOnce();
  await emitKeypress(setup, { name: "return", sequence: "\r" });
  await waitForFrameToContain("TSX");
  await emitKeypress(setup, { name: "down" });
  rejectFurtherSearch = true;
  await emitKeypress(setup, { name: "return", sequence: "\r" });
  await act(async () => { await Bun.sleep(20); });
  await setup.renderOnce();
  expect(saved.at(-1)?.metadata).toMatchObject({ ticker: "SHOP:XTSE", exchange: "TSX", currency: "CAD", watchlists: ["watchlist"] });
  expect(setup.captureCharFrame()).toContain("Search or run a command");
});
