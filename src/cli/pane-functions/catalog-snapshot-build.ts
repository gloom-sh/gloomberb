import { join } from "path";
import type { GloomPlugin } from "../../types/plugin";
import { createDefaultConfig } from "../../types/config";
import { catalogSeriesFacts } from "../series-search";
import type { MarketContext } from "../types";
import { getHeadlessPaneDefinition } from "./capabilities";
import { buildPaneCatalogEntries, buildPaneFunctionLookup } from "./catalog";
import type { CatalogSnapshot, CatalogSnapshotEntry } from "./catalog-snapshot";
import { createPaneCatalog } from "./discovery";
import { namesFunction } from "./resolver";

/**
 * The built-in plugins `fn` may set up without the others: nothing outside one of them reads what its setup leaves
 * behind (a persistence a client attaches, a notification watch), as the FRED series cache rates-macro attaches is
 * read by the chart composer and the other plugins that chart a macro series. `plugin-coupling.test.ts` fails when
 * code one of these plugins loads calls a setup effect that another plugin's module owns.
 */
export const SELF_CONTAINED_PLUGINS: readonly string[] = ["ownership", "news", "screeners"];

const SENTINEL_LIST = { id: "catalog-snapshot-list", name: "Catalog Snapshot List" };

/** A context whose first list holds a symbol (`withList`), or one with no list that holds any. */
function snapshotContext(withList: boolean): MarketContext {
  const config = createDefaultConfig("/catalog-snapshot");
  if (withList) config.watchlists = [{ id: SENTINEL_LIST.id, name: SENTINEL_LIST.name }];
  const held = withList ? [{ metadata: { watchlists: [SENTINEL_LIST.id], portfolios: [], positions: [] } }] : [];
  return { config, store: { loadAllTickers: async () => held } } as unknown as MarketContext;
}

/** The catalog of `plugins` as a fresh profile reads it, with the series they declare. */
export async function buildCatalogSnapshot(plugins: GloomPlugin[]): Promise<CatalogSnapshot> {
  const context = snapshotContext(false);
  // One plugin at a time, each torn down before the next is set up: setups leave state that a dispose undoes.
  const owners = new Map<string, string>();
  for (const plugin of plugins) {
    const own = await createPaneCatalog(context, [plugin]);
    try {
      for (const id of own.paneTemplates.keys()) owners.set(`template:${id}`, plugin.id);
      for (const id of own.panes.keys()) owners.set(`pane:${id}`, plugin.id);
    } finally {
      own.destroy();
    }
  }
  const registry = await createPaneCatalog(context, plugins);
  try {
    const bare = await buildPaneCatalogEntries(registry, context);
    const listed = await buildPaneCatalogEntries(registry, snapshotContext(true));
    const entries = bare.map((entry, index): CatalogSnapshotEntry => {
      const { argExamples, ...rest } = entry;
      const pluginId = (entry.templateId ? owners.get(`template:${entry.templateId}`) : undefined) ?? owners.get(`pane:${entry.paneId}`);
      if (!pluginId) throw new Error(`No plugin holds the function ${entry.token}.`);
      return {
        ...rest,
        pluginId,
        ...argExamples ? { examples: [...argExamples] } : {},
        ...(listed[index]?.argExamples?.length ?? 0) > (argExamples?.length ?? 0) ? { listArgument: true as const } : {},
      };
    });
    // A coded function that reports data, of plugins that stand alone, is found by the words that name it; `fn` then loads only them.
    const order = new Map(plugins.map((plugin, index) => [plugin.id, index]));
    const functions: Record<string, string[]> = {};
    for (const [word, found] of buildPaneFunctionLookup(registry)) {
      if (!("paneId" in found && "description" in found) || !found.shortcut?.prefix) continue;
      const pane = registry.panes.get(found.paneId);
      const holders = [...new Set([owners.get(`template:${found.id}`), owners.get(`pane:${found.paneId}`)])]
        .filter((id): id is string => !!id).sort((a, b) => order.get(a)! - order.get(b)!);
      if (pane && holders.length > 0 && holders.every((id) => SELF_CONTAINED_PLUGINS.includes(id))
        && getHeadlessPaneDefinition(found, pane) && namesFunction(found, pane, word)) functions[word] = holders;
    }
    return { entries, series: catalogSeriesFacts(plugins), functions: Object.fromEntries(Object.entries(functions).sort(([a], [b]) => a.localeCompare(b))) };
  } finally {
    registry.destroy();
  }
}

export const CATALOG_SNAPSHOT_PATH = join(import.meta.dir, "catalog-snapshot.json");

/** One line to a function and to a series, so a change to one reads as a change to one line. */
export function renderCatalogSnapshot(snapshot: CatalogSnapshot): string {
  const lines = (rows: readonly unknown[]) => rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n");
  const functions = Object.entries(snapshot.functions).map(([word, holders]) => `    ${JSON.stringify(word)}: ${JSON.stringify(holders)}`).join(",\n");
  return `{\n  "entries": [\n${lines(snapshot.entries)}\n  ],\n  "series": [\n${lines(snapshot.series)}\n  ],\n  "functions": {\n${functions}\n  }\n}\n`;
}
