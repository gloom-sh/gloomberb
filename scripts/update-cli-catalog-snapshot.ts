/**
 * Writes `src/cli/pane-functions/catalog-snapshot.json`, what `gloom catalog` lists for the built-in plugins:
 * `bun run catalog:snapshot`. The release builds run it (`scripts/build.ts` before it compiles a binary, the
 * build workflow for the npm package); the file is not in git, and a checkout without it asks the plugins.
 */
import { writeFile } from "fs/promises";
import { getLoadablePlugins } from "../src/plugins/catalog";
import { buildCatalogSnapshot, CATALOG_SNAPSHOT_PATH, renderCatalogSnapshot } from "../src/cli/pane-functions/catalog-snapshot-build";

await writeFile(CATALOG_SNAPSHOT_PATH, renderCatalogSnapshot(await buildCatalogSnapshot(getLoadablePlugins([]))));
console.log(`Wrote ${CATALOG_SNAPSHOT_PATH}`);
process.exit(0);
