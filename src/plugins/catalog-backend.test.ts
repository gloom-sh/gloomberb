import { describe, expect, test } from "bun:test";
import { getDesktopBackendPlugins } from "./catalog-backend";
import { getLoadablePlugins } from "./catalog";

describe("desktop backend plugin catalog", () => {
  test("keeps plugin identity and order aligned without renderer-only contributions", () => {
    const backendPlugins = getDesktopBackendPlugins();

    expect(backendPlugins.map((plugin) => plugin.id)).toEqual(
      getLoadablePlugins().map((plugin) => plugin.id),
    );

    for (const pluginId of ["ticker-research", "prediction-markets"]) {
      const plugin = backendPlugins.find((candidate) => candidate.id === pluginId);
      expect(plugin).toBeDefined();
      expect(plugin?.panes).toBeUndefined();
      expect(plugin?.paneTemplates).toBeUndefined();
      expect(plugin?.slots).toBeUndefined();
    }
  });

  test("includes compatible external plugins in the native desktop backend", () => {
    const externalPlugin = {
      id: "external-broker",
      name: "External broker",
      version: "1.0.0",
      targets: ["cli", "tui", "desktop"] as const,
    };
    const backendPlugins = getDesktopBackendPlugins([
      { plugin: externalPlugin, path: "/plugins/external-broker" },
      {
        plugin: { id: "broken", name: "Broken", version: "1.0.0" },
        path: "/plugins/broken",
        error: "load failed",
      },
      {
        plugin: { id: "web-only", name: "Web only", version: "1.0.0" },
        path: "/plugins/web-only",
        unsupportedTarget: "desktop",
      },
    ]);

    expect(backendPlugins).toContain(externalPlugin);
    expect(backendPlugins.some((plugin) => plugin.id === "broken")).toBe(false);
    expect(backendPlugins.some((plugin) => plugin.id === "web-only")).toBe(false);
  });
});
