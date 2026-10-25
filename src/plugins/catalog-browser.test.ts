import { describe, expect, test } from "bun:test";
import { browserBuiltinPlugins } from "./catalog-browser";
import { getLoadablePlugins } from "./catalog";
import { RegistryContributions } from "./registry/contributions";
import { getAvailablePaneShortcutTemplatesForQuery } from "../components/command-bar/pane-templates/items";
import { resolveShellVisibleLayout } from "../components/layout/shell/visible-layout";
import { createDefaultConfig, createPaneInstance } from "../types/config";
import type { PluginRegistry } from "./registry";

const ids = browserBuiltinPlugins.map((plugin) => plugin.id);
const paneIds = browserBuiltinPlugins.flatMap((plugin) => plugin.panes?.map((pane) => pane.id) ?? []);
const templateIds = new Set(browserBuiltinPlugins.flatMap((plugin) => plugin.paneTemplates?.map((template) => template.id) ?? []));

describe("browser plugin catalog", () => {
  test("excludes native, filesystem, and debug plugins", () => {
    for (const forbidden of ["broker", "notes", "debug"]) {
      expect(ids).not.toContain(forbidden);
    }
  });

  test("keeps every public pane handoff restorable in the hosted browser", () => {
    const unavailable = getLoadablePlugins()
      .flatMap((plugin) => plugin.paneTemplates ?? [])
      .filter((template) => template.publicShare && !templateIds.has(template.id))
      .map((template) => template.id);
    expect(unavailable).toEqual([]);
  });

  test("omits unsupported modules inside otherwise browser-safe product areas", () => {
    for (const forbidden of [
      "buildout",
      "market-movers",
    ]) {
      expect(paneIds).not.toContain(forbidden);
    }
  });

  test.each([
    ["browser", browserBuiltinPlugins],
    ["desktop and terminal", getLoadablePlugins()],
  ] as const)("%s offers public research commands and restores their saved panes signed out", (_host, plugins) => {
    const contributions = new RegistryContributions({ wrapComponent: (_id, component) => component });
    for (const plugin of plugins) {
      for (const pane of plugin.panes ?? []) contributions.registerPane(plugin.id, pane);
      for (const template of plugin.paneTemplates ?? []) contributions.registerPaneTemplate(plugin.id, template);
    }
    const config = createDefaultConfig("unused-browser-catalog-profile");
    const registry = {
      paneTemplates: contributions.paneTemplatesMap,
      getPaneTemplatePluginId: (id: string) => contributions.paneTemplatesMap.owners.get(id),
    } as PluginRegistry;
    const functions = [
      ["13F", "thirteenf-funds"],
      ["ERN", "earnings-calendar"],
      ["EVTS", "earnings-calendar"],
      ["HDS AAPL", "holders"],
    ] as const;
    for (const [query, paneId] of functions) {
      const templates = getAvailablePaneShortcutTemplatesForQuery({
        pluginRegistry: registry,
        disabledPlugins: [],
        context: { config, layout: config.layout, focusedPaneId: null, activeTicker: null, activeCollectionId: null },
        query,
      });
      expect(templates.map((template) => template.paneId)).toEqual([paneId]);
    }
    const instances = functions.map(([query, paneId]) => createPaneInstance(paneId, { instanceId: query, binding: { kind: "none" } }));
    const saved = {
      dockRoot: null,
      instances,
      floating: instances.map((pane, index) => ({ instanceId: pane.instanceId, x: index, y: 0, width: 40, height: 20, zIndex: index })),
      detached: [],
    };
    const restored = resolveShellVisibleLayout(saved, new Set(), contributions.panesMap);
    expect(restored.instances).toEqual(instances);
    expect(restored.floating).toEqual(saved.floating);
  });
});
