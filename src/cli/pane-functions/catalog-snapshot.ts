import { shellWord } from "../../utils/shell-word";
import type { CatalogSeriesFact } from "../series-search";
import type { PaneCatalogEntry } from "./catalog";

/**
 * What `catalog` lists for the built-in plugins, written down by `bun run catalog:snapshot`, so that a command which
 * only lists functions reads one file instead of loading every plugin's code to ask each what it is. It holds
 * the catalog as it reads on a fresh profile, and what a reader's own lists change in it is put back by
 * `snapshotEntries`. The file is not in git: the release builds write it (`scripts/build.ts` for a binary, the
 * build workflow for the npm package), and where it is absent the plugins are asked. `catalog-snapshot.test.ts`
 * fails when what the generator writes no longer matches the plugins.
 */
export interface CatalogSnapshotEntry extends Omit<PaneCatalogEntry, "argExamples"> {
  /** The built-in plugin that holds the function. */
  pluginId: string;
  /** The examples the function's own definition gives, past its placeholder. */
  examples?: string[];
  /** The function takes a list of symbols, so the reader's first list is one more example. */
  listArgument?: true;
}

export interface CatalogSnapshot {
  entries: CatalogSnapshotEntry[];
  series: CatalogSeriesFact[];
  /**
   * The built-in plugins a function that reports data (`fn`) is among, in catalog order (its template's, and its
   * pane's when another plugin holds that), by every word that names it (its code, an alias, its id), as the whole
   * catalog settles them. A word that only matches a keyword is not here.
   */
  functions: Record<string, string[]>;
}

/** The catalog entries as the app builds them for a reader whose first list is `listName`. */
export function snapshotEntries(snapshot: CatalogSnapshot, listName: string | null): PaneCatalogEntry[] {
  return snapshot.entries.map(({ pluginId: _pluginId, examples, listArgument, ...entry }) => {
    const shown = listArgument && listName ? [...examples ?? [], shellWord(listName)] : examples ?? [];
    if (shown.length === 0) return entry;
    // The examples sit before the keywords and the shot argument in the entry, as the app builds it.
    const ordered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key === "shotArgument" || key === "keywords") ordered.argExamples ??= shown;
      ordered[key] = value;
    }
    return ordered as unknown as PaneCatalogEntry;
  });
}

let read: CatalogSnapshot | null | undefined;

/** The snapshot file, read when first asked for; null where the build did not write one, and the plugins are asked. */
export function readCatalogSnapshot(): CatalogSnapshot | null {
  if (read !== undefined) return read;
  try {
    read = require("./catalog-snapshot.json") as CatalogSnapshot;
  } catch (error) {
    // Bun says "Cannot find module" from source and "Cannot require module" from a compiled binary; a file that is
    // there and fails to read is not an absent one.
    if (!/Cannot (find|require) module/.test(String((error as { message?: unknown } | null)?.message ?? error))) throw error;
    read = null;
  }
  return read;
}
