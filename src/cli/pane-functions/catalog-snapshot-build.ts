import { join } from "path";
import type { GloomPlugin } from "../../types/plugin";
import { createDefaultConfig } from "../../types/config";
import { catalogSeriesFacts } from "../series-search";
import type { MarketContext } from "../types";
import { buildPaneCatalogEntries } from "./catalog";
import type { CatalogSnapshot, CatalogSnapshotEntry } from "./catalog-snapshot";
import { createPaneCatalog } from "./discovery";

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
  const registry = await createPaneCatalog(context, plugins);
  try {
    const bare = await buildPaneCatalogEntries(registry, context);
    const listed = await buildPaneCatalogEntries(registry, snapshotContext(true));
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
    return { entries, series: catalogSeriesFacts(plugins) };
  } finally {
    registry.destroy();
  }
}

export const CATALOG_SNAPSHOT_PATH = join(import.meta.dir, "catalog-snapshot.json");

/** One line to a function and to a series, so a change to one reads as a change to one line. */
export function renderCatalogSnapshot(snapshot: CatalogSnapshot): string {
  const lines = (rows: readonly unknown[]) => rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n");
  return `{\n  "entries": [\n${lines(snapshot.entries)}\n  ],\n  "series": [\n${lines(snapshot.series)}\n  ]\n}\n`;
}
