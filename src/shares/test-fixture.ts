import { createPaneDiscoveryContext } from "../cli/pane-functions/discovery";
import { getLoadablePlugins } from "../plugins/catalog";
import { createTestTicker } from "../test-support/ticker";
import { createDefaultConfig, type PaneInstanceConfig } from "../types/config";
import type { PaneDef, PanePersonalDataContext } from "../types/plugin";

/** The built-in panes the catalogue declares statically. */
export const paneDefs = new Map<string, PaneDef>(
  getLoadablePlugins().flatMap((plugin) => plugin.panes ?? []).map((pane) => [pane.id, pane]),
);

/** What a pane of `paneType` shows, for its `personalData` rule; a bare instance unless overridden. */
export function personalDataContext(paneType: string, overrides: Partial<PanePersonalDataContext> = {}): PanePersonalDataContext {
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

export const held = new Map([["NVDA", createTestTicker("NVDA", "NVIDIA", { portfolios: ["main"], positions: [{ portfolio: "main", shares: 120, avgCost: 98.4, broker: "manual" }] })]]);
export const followed = new Map([["NVDA", createTestTicker("NVDA", "NVIDIA", { watchlists: ["watchlist"] })]]);

/** Runs `check` over every built-in pane, those a plugin registers in `setup` included, then disposes the plugins. */
export async function withBuiltinPanes<T>(check: (panes: ReadonlyMap<string, PaneDef>) => T): Promise<T> {
  const { panes, paneTemplates: _templates, ...discovery } = createPaneDiscoveryContext({
    getConfig: () => personalDataContext("discovery").config,
    panes: new Map(paneDefs),
  });
  const started: ReturnType<typeof getLoadablePlugins> = [];
  try {
    for (const plugin of getLoadablePlugins()) {
      started.push(plugin);
      await plugin.setup?.(discovery);
    }
    return check(panes);
  } finally {
    for (const plugin of started.reverse()) plugin.dispose?.();
  }
}
