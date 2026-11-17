import { expect, test } from "bun:test";
import { getLoadablePlugins } from "./catalog";
import { BUILTIN_DATA_PLUGIN_IDS, getLoadableDataPlugins } from "./catalog-data";

test("every built-in plugin that declares an asset-data or news capability is in the list data commands load", () => {
  const providers = getLoadablePlugins([])
    .filter((plugin) => (plugin.capabilities ?? []).some((capability) => capability.kind === "asset-data" || capability.kind === "news"))
    .map((plugin) => plugin.id);
  expect(providers.length).toBeGreaterThan(0);
  expect(new Set(BUILTIN_DATA_PLUGIN_IDS)).toEqual(new Set(providers));
  expect(getLoadableDataPlugins().map((plugin) => plugin.id)).toEqual([...BUILTIN_DATA_PLUGIN_IDS]);
});
