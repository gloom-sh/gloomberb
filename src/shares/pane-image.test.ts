import { describe, expect, test } from "bun:test";
import type { PanePersonalDataContext } from "../types/plugin";
import { resolvePanePersonalData } from "./pane-image";
import { followed, held, paneDefs, personalDataContext as context, withBuiltinPanes } from "./test-fixture";

function personalData(paneType: string, overrides: Partial<PanePersonalDataContext> = {}) {
  return resolvePanePersonalData(paneDefs.get(paneType), context(paneType, overrides));
}

describe("which panes ask before their picture is posted to chat", () => {
  test("every built-in pane with private portable data declares picture privacy", async () => {
    // No exceptions today. A future exception must name the pane and explain
    // why its private portable fields cannot expose personal data in a picture.
    expect(await withBuiltinPanes((panes) => [...panes.values()]
      .filter((pane) => pane.portableShare?.private && pane.personalData === undefined)
      .map((pane) => pane.id).sort())).toEqual([]);
  });

  test.each([
    { name: "a portfolio", pane: "portfolio-list", overrides: { activeCollectionId: "main" }, expected: "holdings" },
    { name: "a watchlist", pane: "portfolio-list", overrides: { activeCollectionId: "watchlist" }, expected: null },
    { name: "a held ticker's research", pane: "ticker-research", overrides: { activeTicker: "NVDA", tickers: held }, expected: "holdings" },
    { name: "a watched ticker's research", pane: "ticker-research", overrides: { activeTicker: "NVDA", tickers: followed }, expected: null },
    { name: "research notes on an unheld ticker", pane: "ticker-research", overrides: { paneState: { activeTabId: "notes" } }, expected: "messages" },
    { name: "research thesis on an unheld ticker", pane: "ticker-research", overrides: { paneState: { activeTabId: "thesis" } }, expected: "holdings" },
    { name: "research locked to notes", pane: "ticker-research", overrides: { settings: { hideTabs: true, lockedTabId: "notes" }, paneState: { activeTabId: "overview" } }, expected: "messages" },
    { name: "research locked to thesis", pane: "ticker-research", overrides: { settings: { hideTabs: true, lockedTabId: "thesis" }, paneState: { activeTabId: "overview" } }, expected: "holdings" },
    { name: "market research with an inactive notes tab", pane: "ticker-research", overrides: { settings: { hideTabs: true, lockedTabId: "overview" }, paneState: { activeTabId: "notes" } }, expected: null },
    { name: "a portfolio value heatmap", pane: "market-heatmap", overrides: { settings: { universe: "portfolio" }, paneState: { collectionKind: "portfolio" } }, expected: "holdings" },
    { name: "a watchlist heatmap", pane: "market-heatmap", overrides: { settings: { universe: "portfolio" }, paneState: { collectionKind: "watchlist" } }, expected: null },
    { name: "a market heatmap with an inactive portfolio tab", pane: "market-heatmap", overrides: { settings: { universe: "us-equity" }, paneState: { collectionKind: "portfolio" } }, expected: null },
    { name: "earnings with held-position markers", pane: "earnings-calendar", overrides: { tickers: held }, expected: "holdings" },
    { name: "earnings with watchlist markers only", pane: "earnings-calendar", overrides: { tickers: followed }, expected: null },
    { name: "earnings scoped to held tickers", pane: "earnings-calendar", overrides: { settings: { symbols: ["NVDA", "FABLE"] }, tickers: held }, expected: "holdings" },
    { name: "earnings scoped away from held tickers", pane: "earnings-calendar", overrides: { settings: { symbols: ["FABLE", "MYTH"] }, tickers: held }, expected: null },
    { name: "public single-ticker earnings history", pane: "earnings-calendar", overrides: { settings: { symbols: ["NVDA"] }, tickers: held }, expected: null },
    { name: "earnings board regardless of its ticker scope", pane: "earnings-calendar", overrides: { settings: { board: true, symbols: ["NVDA"] }, tickers: held }, expected: "holdings" },
    { name: "options on a held ticker", pane: "options", overrides: { activeTicker: "NVDA", tickers: held }, expected: "holdings" },
    { name: "earnings ripple over the portfolios", pane: "earnings-ripple", overrides: {}, expected: "holdings" },
    { name: "earnings ripple on named tickers", pane: "earnings-ripple", overrides: { settings: { symbols: "AAPL MSFT" } }, expected: null },
    { name: "a public channel", pane: "chat", overrides: { settings: { channelId: "everyone" } }, expected: null },
    { name: "a DM", pane: "chat", overrides: { settings: { channelId: "dm:u1:u2" } }, expected: "messages" },
    { name: "a team channel", pane: "chat", overrides: { settings: { channelId: "team:abc" } }, expected: "messages" },
    { name: "broker accounts", pane: "brokers", overrides: {}, expected: "account" },
  ])("$name", ({ pane, overrides, expected }) => {
    expect(personalData(pane, overrides as Partial<PanePersonalDataContext>)).toBe(expected as ReturnType<typeof personalData>);
  });

  test("a broker plugin's pane that says nothing is taken to show holdings", () => {
    const orders = { personalData: undefined };
    expect(resolvePanePersonalData(orders, context("ibkr-orders"), { ownerConnectsBroker: true })).toBe("holdings");
    expect(resolvePanePersonalData(orders, context("quotes"), { ownerConnectsBroker: false })).toBeNull();
    expect(resolvePanePersonalData(paneDefs.get("ticker-research"), context("ticker-research"), { ownerConnectsBroker: true })).toBeNull();
  });
});
