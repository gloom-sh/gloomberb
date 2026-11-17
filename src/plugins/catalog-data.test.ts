import { expect, test } from "bun:test";
import { getLoadablePlugins } from "./catalog";
import { builtinDataPlugins } from "./catalog-data";

test("every built-in plugin that declares an asset-data or news capability is in the list data commands load", () => {
  const providers = getLoadablePlugins([])
    .filter((plugin) => (plugin.capabilities ?? []).some((capability) => capability.kind === "asset-data" || capability.kind === "news"))
    .map((plugin) => plugin.id);
  expect(providers.length).toBeGreaterThan(0);
  expect(new Set(builtinDataPlugins.map((plugin) => plugin.id))).toEqual(new Set(providers));
});
