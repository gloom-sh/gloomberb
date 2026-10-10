import { describe, expect, test } from "bun:test";
import { getDesktopBackendPlugins } from "./catalog-backend";
import { getLoadablePlugins } from "./catalog";
import { paneStateNamespace } from "./test-fixture";

describe("desktop backend plugin catalog", () => {
  test("keeps plugin identity and order aligned, and runs no Ticker Research module", () => {
    const backendPlugins = getDesktopBackendPlugins();
    const rendererPlugins = getLoadablePlugins();

    expect(backendPlugins.map((plugin) => plugin.id)).toEqual(rendererPlugins.map((plugin) => plugin.id));

    // Ticker Research's modules, wherever they sit now, are renderer-only: the
    // plugins holding nothing else keep their identity alone, and the others
    // run what they had before.
    for (const [index, plugin] of rendererPlugins.entries()) {
      const backend = backendPlugins[index]!;
      const kept = (plugin.panes ?? [])
        .filter((pane) => paneStateNamespace(plugin, pane.id) !== "ticker-research")
        .map((pane) => pane.id);
      expect({ id: plugin.id, panes: (backend.panes ?? []).map((pane) => pane.id) }).toEqual({ id: plugin.id, panes: kept });
    }
    for (const pluginId of ["ticker-core", "options-volatility", "ownership", "filings"]) {
      const plugin = backendPlugins.find((candidate) => candidate.id === pluginId);
      expect(plugin).toMatchObject({ id: pluginId, stateId: "ticker-research", toggleable: true });
      for (const key of ["panes", "paneTemplates", "slots", "capabilities", "cliCommands"] as const) {
        expect(plugin?.[key]).toBeUndefined();
      }
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
