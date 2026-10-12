import { describe, expect, test } from "bun:test";
import { getLoadablePlugins } from "../plugins/catalog";
import { createTestTicker } from "../test-support/ticker";
import { createDefaultConfig, type PaneInstanceConfig } from "../types/config";
import type { PaneDef, PanePersonalDataContext } from "../types/plugin";
import { resolvePanePersonalData } from "./pane-image";

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

const held = new Map([["NVDA", createTestTicker("NVDA", "NVIDIA", { positions: [{ portfolio: "main", shares: 120, avgCost: 98.4, broker: "manual" }] })]]);
const followed = new Map([["NVDA", createTestTicker("NVDA", "NVIDIA", { watchlists: ["watchlist"] })]]);

describe("which panes ask before their picture is posted to chat", () => {
  // The catalogue's personal data, so a new pane that shows it is a decision here, not an oversight.
  test("only panes that can show the person's own data declare it", () => {
    const declared = [...paneDefs.values()].filter((pane) => pane.personalData).map((pane) => pane.id).sort();
    expect(declared).toEqual([
      "account-management",
      "analytics",
      "askg",
      "brokers",
      "chat",
      "earnings-ripple",
      "kelly-sizer",
      "options",
      "portfolio-list",
      "team",
      "ticker-research",
      "unread-inbox",
    ]);
  });

  test.each([
    { name: "a portfolio", pane: "portfolio-list", overrides: { activeCollectionId: "main" }, expected: "holdings" },
    { name: "a watchlist", pane: "portfolio-list", overrides: { activeCollectionId: "watchlist" }, expected: null },
    { name: "a held ticker's research", pane: "ticker-research", overrides: { activeTicker: "NVDA", tickers: held }, expected: "holdings" },
    { name: "a watched ticker's research", pane: "ticker-research", overrides: { activeTicker: "NVDA", tickers: followed }, expected: null },
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
