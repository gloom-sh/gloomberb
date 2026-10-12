import { describe, expect, test } from "bun:test";
import type { PluginRegistry } from "../plugins/registry";
import type { BrokerAdapter } from "../types/broker";
import type { PaneDef, PanePersonalDataContext } from "../types/plugin";
import { missingPanePlaceholderDef } from "../components/layout/missing-pane";
import { paneShowsPersonalData } from "./personal-pane";
import { held, paneDefs, personalDataContext, withBuiltinPanes } from "./test-fixture";

const noBrokers = { brokers: new Map(), getPanePluginId: () => undefined, getBrokerPluginId: () => undefined };

function asksAboutPane(def: Pick<PaneDef, "personalData"> | undefined, paneType: string, overrides: Partial<PanePersonalDataContext> = {}) {
  return paneShowsPersonalData({ registry: noBrokers, def, context: personalDataContext(paneType, overrides) });
}

describe("which panes Ask Gloom asks about before it reads them", () => {
  test("a pane that keeps fields private when shared is still personal in some instance", async () => {
    // Instances a pane's rule may tell apart: nothing set, a private conversation, a held ticker.
    const instances: Array<Partial<PanePersonalDataContext>> = [
      {},
      { settings: { channelId: "dm:u1:u2" } },
      { activeTicker: "NVDA", tickers: held },
    ];
    const sharedPrivately = await withBuiltinPanes((panes) => [...panes.values(), missingPanePlaceholderDef("gone-plugin:view")]
      .filter((pane) => pane.portableShare?.private));
    expect(sharedPrivately.length).toBeGreaterThan(10);
    expect(sharedPrivately
      .filter((pane) => !instances.some((overrides) => asksAboutPane(pane, pane.id, overrides)))
      .map((pane) => pane.id)).toEqual([]);
  });

  // The ones whose answer is not the one Ask Gloom gave before it read the
  // declaration: a pane that keeps fields private when shared, its plugin's
  // broker, a ticker held, or a portfolio named in its settings.
  test.each([
    { name: "a DM", pane: "chat", overrides: { settings: { channelId: "dm:u1:u2" } }, expected: true },
    { name: "a public channel, declared public (was personal for keeping fields private)", pane: "chat", overrides: { settings: { channelId: "everyone" } }, expected: false },
    { name: "a watchlist, declared public (was personal for keeping fields private)", pane: "portfolio-list", overrides: { activeCollectionId: "watchlist" }, expected: false },
    { name: "research on a held ticker", pane: "ticker-research", overrides: { activeTicker: "NVDA", tickers: held }, expected: true },
    { name: "a chart of a held ticker, which shows no position (was personal for the ticker)", pane: "chart-composer", overrides: { activeTicker: "NVDA", tickers: held }, expected: false },
    { name: "a heatmap that remembers a portfolio it is not showing (was personal for the setting)", pane: "market-heatmap", overrides: { settings: { universe: "us-equity" }, paneState: { portfolioSourceId: "main" } }, expected: false },
    { name: "the unread chat inbox, which declares messages (was not personal)", pane: "unread-inbox", overrides: {}, expected: true },
  ])("$name", ({ pane, overrides, expected }) => {
    expect(asksAboutPane(paneDefs.get(pane), pane, overrides as Partial<PanePersonalDataContext>)).toBe(expected);
  });

  test("a pane from a plugin this terminal lacks asks, and so does one of a broker plugin that declares nothing", () => {
    expect(asksAboutPane(missingPanePlaceholderDef("gone-plugin:view"), "gone-plugin:view")).toBe(true);

    const registry = {
      brokers: new Map([["ibkr", {} as BrokerAdapter]]),
      getPanePluginId: (paneType: string) => (paneType === "ibkr-orders" ? "ibkr" : "market"),
      getBrokerPluginId: () => "ibkr",
    } satisfies Pick<PluginRegistry, "brokers" | "getPanePluginId" | "getBrokerPluginId">;
    const ask = (paneType: string) => paneShowsPersonalData({ registry, def: {}, context: personalDataContext(paneType) });
    expect(ask("ibkr-orders")).toBe(true);
    expect(ask("quotes")).toBe(false);
  });
});
