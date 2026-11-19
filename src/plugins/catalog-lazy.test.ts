import { expect, test } from "bun:test";
import { uiBuiltinPlugins } from "./catalog-ui";
import { lazyBuiltinPlugins, loadBuiltinPlugin } from "./catalog-lazy";

test("the lazy list holds the same plugins as the apps load, in the same order, and loads the very same objects", () => {
  expect(lazyBuiltinPlugins.map((plugin) => plugin.id)).toEqual(uiBuiltinPlugins.map((plugin) => plugin.id));
  for (const [index, plugin] of uiBuiltinPlugins.entries()) expect(lazyBuiltinPlugins[index]!.load()).toBe(plugin);
  expect(loadBuiltinPlugin("ownership")).toBe(uiBuiltinPlugins.find((plugin) => plugin.id === "ownership"));
  expect(loadBuiltinPlugin("no-such-plugin")).toBeUndefined();
});
