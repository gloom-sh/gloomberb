import { describe, expect, test } from "bun:test";
import { getDesktopBackendPlugins } from "./catalog-backend";
import { getLoadablePlugins } from "./catalog";

describe("desktop backend plugin catalog", () => {
  test("keeps plugin identity and order aligned without renderer-only modules", () => {
    const backendPlugins = getDesktopBackendPlugins();
    const rendererPlugins = getLoadablePlugins();

    expect(backendPlugins.map((plugin) => plugin.id)).toEqual(rendererPlugins.map((plugin) => plugin.id));

    // Every Ticker Research module is renderer-only, so the backend keeps its identity alone.
    const tickerResearch = backendPlugins.find((candidate) => candidate.id === "ticker-research");
    expect(tickerResearch).toMatchObject({ id: "ticker-research", toggleable: true });
    for (const key of ["panes", "paneTemplates", "slots", "capabilities", "cliCommands"] as const) {
      expect(tickerResearch?.[key]).toBeUndefined();
    }
    // The rest run whole, as the renderer has them.
    expect(backendPlugins.filter((plugin) => plugin.id !== "ticker-research"))
      .toEqual(rendererPlugins.filter((plugin) => plugin.id !== "ticker-research"));
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
