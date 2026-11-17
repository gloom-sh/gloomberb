/**
 * Rewrites `src/cli/pane-functions/catalog-snapshot.json`, what `gloom catalog` lists for the built-in plugins:
 * `bun run catalog:snapshot`. Run it after a plugin's functions, options, descriptions or series change.
 * `--check` leaves the file alone and fails when it is out of date.
 */
import { readFile, writeFile } from "fs/promises";
import { getLoadablePlugins } from "../src/plugins/catalog";
import { buildCatalogSnapshot, CATALOG_SNAPSHOT_PATH, renderCatalogSnapshot } from "../src/cli/pane-functions/catalog-snapshot-build";

const text = renderCatalogSnapshot(await buildCatalogSnapshot(getLoadablePlugins([])));
if (process.argv.includes("--check")) {
  const current = await readFile(CATALOG_SNAPSHOT_PATH, "utf8").catch(() => "");
  if (current !== text) {
    console.error("src/cli/pane-functions/catalog-snapshot.json is out of date: run `bun run catalog:snapshot`.");
    process.exit(1);
  }
  console.log("The catalog snapshot is current.");
} else {
  await writeFile(CATALOG_SNAPSHOT_PATH, text);
  console.log(`Wrote ${CATALOG_SNAPSHOT_PATH}`);
}
process.exit(0);
