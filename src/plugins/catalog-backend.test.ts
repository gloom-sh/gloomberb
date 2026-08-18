import { describe, expect, test } from "bun:test";
import { getDesktopBackendPlugins } from "./catalog-backend";
import { getLoadablePlugins } from "./catalog";

describe("desktop backend plugin catalog", () => {
  test("keeps plugin identity and order aligned without renderer-only contributions", () => {
    const backendPlugins = getDesktopBackendPlugins();

    expect(backendPlugins.map((plugin) => plugin.id)).toEqual(
      getLoadablePlugins().map((plugin) => plugin.id),
    );

    for (const pluginId of ["ticker-research", "prediction-markets", "polls"]) {
      const plugin = backendPlugins.find((candidate) => candidate.id === pluginId);
      expect(plugin).toBeDefined();
      expect(plugin?.panes).toBeUndefined();
      expect(plugin?.paneTemplates).toBeUndefined();
      expect(plugin?.slots).toBeUndefined();
    }
  });
});
