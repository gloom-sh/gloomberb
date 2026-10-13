import { describe, expect, test } from "bun:test";
import { getLoadablePlugins } from "../plugins/catalog";
import { loadBuiltinPanes } from "../test-support/builtin-panes";
import { createTestTicker } from "../test-support/ticker";
import { createDefaultConfig, type PaneInstanceConfig } from "../types/config";
import type { PaneDef, PanePersonalDataContext } from "../types/plugin";
import { personalDataQuestion, resolvePanePersonalData } from "./pane-image";

const paneDefs = new Map<string, PaneDef>(
  getLoadablePlugins().flatMap((plugin) => plugin.panes ?? []).map((pane) => [pane.id, pane]),
);

function context(paneType: string, overrides: Partial<PanePersonalDataContext> = {}): PanePersonalDataContext {
  const config = createDefaultConfig("/gloom");
  const pane: PaneInstanceConfig = { instanceId: `${paneType}:test`, paneId: paneType, binding: { kind: "none" } } as PaneInstanceConfig;
  return {
    config,
    layout: config.layout,
    paneId: pane.instanceId,
    paneType,
    pane,
    settings: {},
    paneState: {},
    activeTicker: null,
    activeCollectionId: null,
    tickers: new Map(),
    ...overrides,
  };
}

function personalData(paneType: string, overrides: Partial<PanePersonalDataContext> = {}) {
  return resolvePanePersonalData(paneDefs.get(paneType), context(paneType, overrides));
}

const held = new Map([["NVDA", createTestTicker("NVDA", "NVIDIA", { portfolios: ["main"], positions: [{ portfolio: "main", shares: 120, avgCost: 98.4, broker: "manual" }] })]]);
const followed = new Map([["NVDA", createTestTicker("NVDA", "NVIDIA", { watchlists: ["watchlist"] })]]);

describe("which panes ask before their picture is posted to chat", () => {
  test("every built-in pane with private portable data declares picture privacy", async () => {
    // Includes setup-registered panes, not just the catalogue's static definitions.
    const { panes, dispose } = await loadBuiltinPanes();
    try {
      // The fallback for an undeclared private pane exists for plugins written before
      // `personalData`; built-ins say exactly what they show. No exceptions today. A future
      // exception must name the pane and explain why its private portable fields cannot expose
      // personal data in a picture or an attachment.
      expect([...panes.values()]
        .filter((pane) => pane.portableShare?.private && pane.personalData === undefined)
        .map((pane) => pane.id).sort()).toEqual([]);
    } finally {
      dispose();
    }
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

  test("a pane that says nothing but keeps fields private when shared asks about its own data, unless a declaration says otherwise", () => {
    const vault = { portableShare: { private: { state: true } } };
    const ask = (def: Parameters<typeof resolvePanePersonalData>[0], options = {}) => resolvePanePersonalData(def, context("vault"), options);
    expect(ask(vault)).toBe("personal");
    expect(personalDataQuestion("personal")).toBe("This shows your own data. Post it?");
    // A broker plugin's pane stays holdings, declared or not.
    expect(ask(vault, { ownerConnectsBroker: true })).toBe("holdings");
    // Any declaration wins, a rule that returns null included.
    expect(ask({ ...vault, personalData: () => null })).toBeNull();
    expect(ask({ ...vault, personalData: () => null }, { ownerConnectsBroker: true })).toBeNull();
    expect(ask({ ...vault, personalData: "messages" })).toBe("messages");
    expect(ask({ portableShare: { prepare: (pane) => pane } })).toBeNull();
    // A rule that throws is not read as an answer.
    expect(() => ask({ ...vault, personalData: () => { throw new Error("cannot read it"); } })).toThrow();
  });
});
