import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { attachPane } from "../plugins/builtin/cloud/askg/pane-attachment";
import type { PluginRegistry } from "../plugins/registry";
import { panePersonalData } from "../shares/personal-pane";
import { createInitialState, type AppState } from "../state/app/context";
import { loadBuiltinPanes } from "../test-support/builtin-panes";
import { createTestTicker } from "../test-support/ticker";
import { createDefaultConfig, type PaneInstanceConfig } from "../types/config";
import type { PaneDef } from "../types/plugin";
import { buildAskGloomPaneAttachment } from "./pane-context";

const NOT_A_PANE = () => null;
const brokerPlugin = {
  "ibkr-orders": { id: "ibkr-orders", name: "Orders", component: NOT_A_PANE, defaultPosition: "right" },
  "ibkr-quotes": { id: "ibkr-quotes", name: "Quotes", component: NOT_A_PANE, defaultPosition: "right", personalData: () => null },
  "broken-rule": {
    id: "broken-rule", name: "Broken", component: NOT_A_PANE, defaultPosition: "right",
    personalData: () => { throw new Error("cannot read it"); },
  },
} satisfies Record<string, PaneDef>;
/** An external plugin with no broker, written before `personalData` existed. */
const vaultPlugin = {
  "vault-notes": { id: "vault-notes", name: "Vault", component: NOT_A_PANE, defaultPosition: "right", portableShare: { private: { state: true } } },
  "vault-public": {
    id: "vault-public", name: "Vault board", component: NOT_A_PANE, defaultPosition: "right",
    portableShare: { private: { state: true } }, personalData: () => null,
  },
} satisfies Record<string, PaneDef>;
const defs = new Map<string, PaneDef>(Object.entries({ ...brokerPlugin, ...vaultPlugin }));
let disposeBuiltinPanes = () => {};

beforeAll(async () => {
  const builtin = await loadBuiltinPanes();
  disposeBuiltinPanes = builtin.dispose;
  for (const [id, def] of builtin.panes) defs.set(id, def);
});

afterAll(() => disposeBuiltinPanes());

/** The registry as the shell has it, with an external plugin that connects a broker and one that does not. */
const registry = {
  paneTemplates: new Map(),
  brokers: new Map([["ibkr", {}]]),
  getPanePluginId: (paneType: string) => (paneType in brokerPlugin ? "ibkr" : paneType in vaultPlugin ? "vault" : "builtin"),
  getBrokerPluginId: () => "ibkr",
} as unknown as PluginRegistry;

const held = new Map([["NVDA", createTestTicker("NVDA", "NVIDIA", { portfolios: ["main"], positions: [{ portfolio: "main", shares: 120, avgCost: 98.4, broker: "manual" }] })]]);
const followed = new Map([["NVDA", createTestTicker("NVDA", "NVIDIA", { watchlists: ["watchlist"] })]]);

interface Scene {
  paneType: string;
  settings?: Record<string, unknown>;
  paneState?: Record<string, unknown>;
  /** Shows NVDA, as a chart or a research pane on it does. */
  symbol?: "NVDA";
  /** Follows a portfolio pane open on this collection. */
  followsCollection?: string;
  tickers?: Map<string, ReturnType<typeof createTestTicker>>;
  lastChatChannelId?: string;
}

/** A pane on the real state and layout, as the shell hands it over. */
function attach(scene: Scene) {
  const config = createDefaultConfig("/gloom");
  if (scene.lastChatChannelId) config.pluginConfig = { "gloomberb-cloud": { lastChatChannelId: scene.lastChatChannelId } };
  const source: PaneInstanceConfig = { instanceId: "portfolio-list:source", paneId: "portfolio-list", binding: { kind: "none" } };
  const instance: PaneInstanceConfig = {
    instanceId: `${scene.paneType}:test`,
    paneId: scene.paneType,
    settings: scene.settings,
    binding: scene.followsCollection
      ? { kind: "follow", sourceInstanceId: source.instanceId }
      : scene.symbol ? { kind: "fixed", symbol: scene.symbol } : { kind: "none" },
  };
  config.layout = { ...config.layout, instances: [...config.layout.instances, source, instance] };
  const initial = createInitialState(config);
  const state: AppState = {
    ...initial,
    tickers: scene.tickers ?? new Map(),
    paneState: {
      ...initial.paneState,
      [source.instanceId]: { collectionId: scene.followsCollection ?? "main" },
      [instance.instanceId]: scene.paneState ?? {},
    },
  };
  const pane = { instance, def: defs.get(scene.paneType)! };
  const shared = { registry, state, layout: state.config.layout, pane };
  const attachment = buildAskGloomPaneAttachment({ ...shared, title: "Example", visibleText: "ACME  120 shares" });
  return { attachment, shareAnswer: () => panePersonalData(shared) };
}

describe("Ask Gloom asks before attaching what the share path asks about", () => {
  test.each<{ name: string; scene: Scene; asks: boolean }>([
    { name: "a portfolio", scene: { paneType: "portfolio-list", paneState: { collectionId: "main" } }, asks: true },
    { name: "a watchlist", scene: { paneType: "portfolio-list", paneState: { collectionId: "watchlist" } }, asks: false },
    { name: "research on a held ticker", scene: { paneType: "ticker-research", symbol: "NVDA", tickers: held }, asks: true },
    { name: "research on a followed ticker", scene: { paneType: "ticker-research", symbol: "NVDA", tickers: followed }, asks: false },
    { name: "research notes on a ticker that is not held", scene: { paneType: "ticker-research", symbol: "NVDA", tickers: followed, paneState: { activeTabId: "notes" } }, asks: true },
    // Market data, even for a ticker that is held: the old inference asked about every pane on one.
    { name: "a chart of a held ticker", scene: { paneType: "chart-composer", symbol: "NVDA", tickers: held }, asks: false },
    { name: "news on a held ticker", scene: { paneType: "ticker-news", symbol: "NVDA", tickers: held }, asks: false },
    // Declared as holdings, messages and account data, without the fields they keep private when shared.
    { name: "the unread inbox", scene: { paneType: "unread-inbox" }, asks: true },
    { name: "quick notes", scene: { paneType: "quick-notes" }, asks: true },
    { name: "a heatmap of a portfolio", scene: { paneType: "market-heatmap", settings: { universe: "portfolio" }, paneState: { collectionKind: "portfolio" } }, asks: true },
    { name: "a heatmap of the market with a held ticker under the cursor", scene: { paneType: "market-heatmap", settings: { universe: "us-equity" }, paneState: { cursorSymbol: "NVDA" }, tickers: held }, asks: false },
    { name: "a public channel", scene: { paneType: "chat", settings: { channelId: "everyone" } }, asks: false },
    { name: "a DM", scene: { paneType: "chat", settings: { channelId: "dm:u1:u2" } }, asks: true },
    { name: "a chat pane that has no channel yet, with a DM last visited", scene: { paneType: "chat", lastChatChannelId: "dm:u1:u2" }, asks: true },
    { name: "rotation linked to a portfolio", scene: { paneType: "relative-rotation", settings: { scope: "collection" }, followsCollection: "main" }, asks: true },
    { name: "rotation linked to a watchlist", scene: { paneType: "relative-rotation", settings: { scope: "collection" }, followsCollection: "watchlist" }, asks: false },
    { name: "the volatility screen linked to a portfolio", scene: { paneType: "iv-screen", settings: { scope: "collection" }, followsCollection: "main" }, asks: true },
    { name: "rotation of the sectors beside a portfolio", scene: { paneType: "relative-rotation", settings: { scope: "sectors" }, followsCollection: "main" }, asks: false },
    { name: "an external broker plugin's pane that declares nothing", scene: { paneType: "ibkr-orders" }, asks: true },
    { name: "an external broker plugin's pane that opts out", scene: { paneType: "ibkr-quotes" }, asks: false },
    { name: "an external plugin's pane with private fields and no declaration", scene: { paneType: "vault-notes" }, asks: true },
    { name: "the same plugin's pane that declares it shows nothing personal", scene: { paneType: "vault-public" }, asks: false },
    { name: "a pane whose rule cannot be read", scene: { paneType: "broken-rule" }, asks: true },
  ])("$name", ({ scene, asks }) => {
    const { attachment, shareAnswer } = attach(scene);
    expect(attachment.personal).toBe(asks);
    expect(attachPane(attachment).consent).toBe(asks ? "pending" : "not-needed");
    // The share path reads the same declaration, so the two cannot disagree. A rule that throws fails the share instead.
    if (scene.paneType === "broken-rule") expect(shareAnswer).toThrow();
    else expect(shareAnswer() !== null).toBe(attachment.personal);
  });
});
