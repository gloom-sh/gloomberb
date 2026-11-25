import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { PaneDef, TickerResearchTabDef } from "../../types/plugin";
import { getLoadablePlugins } from "../catalog";
import { LIVE_STREAMING_SETTING_KEY } from "../../state/hooks/live-streaming";
import { RegistryContributions } from "./contributions";

type Component = (props: never) => ReactNode;

/** A registry whose wrapper counts: it runs when a registered component is first read, and not before. */
function countingContributions() {
  const wrapped: Array<{ pluginId: string; component: Component }> = [];
  const contributions = new RegistryContributions({
    wrapComponent: (pluginId, component) => {
      wrapped.push({ pluginId, component: component as Component });
      return ((props) => component(props)) as typeof component;
    },
  });
  return { contributions, wrapped };
}

function lazyPane(id: string, load: () => Component): PaneDef {
  return {
    id,
    name: id,
    icon: "L",
    tickerFollower: true,
    defaultPosition: "right",
    get component() { return load() as PaneDef["component"]; },
  };
}

describe("registered panes and research tabs", () => {
  test("a pane's lazy component is read, and wrapped, only when first asked for", () => {
    const { contributions, wrapped } = countingContributions();
    let loads = 0;
    const loaded: Component = () => null;
    contributions.registerPane("owner", lazyPane("lazy", () => { loads++; return loaded; }));

    const registered = contributions.panesMap.get("lazy")!;
    expect(loads).toBe(0);
    expect(wrapped).toHaveLength(0);
    // Everything but the component reads as it was declared.
    expect(registered).toMatchObject({ id: "lazy", name: "lazy", icon: "L", tickerFollower: true, defaultPosition: "right" });
    expect(loads).toBe(0);

    const component = registered.component;
    expect(wrapped).toEqual([{ pluginId: "owner", component: loaded }]);
    // One identity for every render: React would remount the pane on a new one.
    expect(registered.component).toBe(component);
    expect(contributions.panesMap.get("lazy")!.component).toBe(component);
    expect(loads).toBe(1);
    expect(wrapped).toHaveLength(1);
  });

  test("a plain component, as external plugins pass, is wrapped the same way", () => {
    const { contributions, wrapped } = countingContributions();
    const component = () => null;
    contributions.registerPane("external", { id: "plain", name: "Plain", component, defaultPosition: "left" });
    contributions.registerTickerResearchTab("external", { id: "plain-tab", name: "Plain", order: 1, component });

    const pane = contributions.panesMap.get("plain")!;
    const tab = contributions.tickerResearchTabsMap.get("plain-tab")!;
    expect(pane.component).toBe(pane.component);
    expect(tab.component).toBe(tab.component);
    expect(wrapped.map((entry) => [entry.pluginId, entry.component])).toEqual([["external", component], ["external", component]]);
    expect(Object.keys(pane)).toContain("component");
  });

  test("a research tab's lazy component is read only when first asked for", () => {
    const { contributions, wrapped } = countingContributions();
    let loads = 0;
    const tab: TickerResearchTabDef = {
      id: "lazy-tab",
      name: "Lazy",
      order: 3,
      instruments: ["equity"],
      get component() { loads++; return (() => null) as TickerResearchTabDef["component"]; },
    };
    contributions.registerTickerResearchTab("owner", tab);

    const registered = contributions.tickerResearchTabsMap.get("lazy-tab")!;
    expect(registered).toMatchObject({ id: "lazy-tab", name: "Lazy", order: 3, instruments: ["equity"] });
    expect(loads).toBe(0);
    expect(wrapped).toHaveLength(0);
    expect(registered.component).toBe(registered.component);
    expect(loads).toBe(1);
  });

  test("a component that fails to load fails when the pane renders, and is tried again", () => {
    const { contributions, wrapped } = countingContributions();
    let attempts = 0;
    const loaded = () => null;
    contributions.registerPane("owner", lazyPane("flaky", () => {
      if (++attempts === 1) throw new Error("module failed to load");
      return loaded;
    }));

    // Reading it, as the layout does outside the pane's error card, does not throw.
    const failing = contributions.panesMap.get("flaky")!.component as () => unknown;
    expect(() => failing()).toThrow("module failed to load");
    expect(wrapped).toHaveLength(0);
    const retried = contributions.panesMap.get("flaky")!.component;
    expect(wrapped.map((entry) => entry.component)).toEqual([loaded]);
    expect(contributions.panesMap.get("flaky")!.component).toBe(retried);
  });

  // Startup registers every built-in pane, about 70 of which load their module on first use.
  test("registering every built-in pane loads none of them, and each one loads when read", () => {
    const { contributions, wrapped } = countingContributions();
    const declared: Array<{ pluginId: string; pane: PaneDef }> = [];
    for (const plugin of getLoadablePlugins()) {
      for (const pane of plugin.panes ?? []) declared.push({ pluginId: plugin.id, pane });
    }
    const lazy = declared.filter(({ pane }) => !!Object.getOwnPropertyDescriptor(pane, "component")?.get);
    expect(lazy.length).toBeGreaterThan(50);

    for (const { pluginId, pane } of declared) contributions.registerPane(pluginId, pane);
    expect(wrapped).toHaveLength(0);

    for (const { pane } of declared) {
      expect(typeof contributions.panesMap.get(pane.id)!.component, pane.id).toBe("function");
    }
    expect(wrapped).toHaveLength(declared.length);
    // What was wrapped is the component each pane declares: a module that fails to load throws here.
    for (const { pluginId, pane } of declared) {
      expect(wrapped.find((entry) => entry.component === pane.component)?.pluginId, pane.id).toBe(pluginId);
    }
  });

  // ⚡ in a pane header reads as live data, so every other toggle there takes a glyph of its own.
  test("no built-in quick setting but live streaming draws the live glyph", () => {
    const zaps = getLoadablePlugins().flatMap((plugin) => (plugin.panes ?? []).flatMap((pane) => (
      (pane.quickSettings ?? []).filter((setting) => setting.icon === "zap").map((setting) => `${pane.id}: ${setting.key}`)
    )));
    expect(zaps.length).toBeGreaterThan(0);
    expect(zaps.filter((entry) => !entry.endsWith(`: ${LIVE_STREAMING_SETTING_KEY}`))).toEqual([]);
  });
});

describe("a contribution without a usable id", () => {
  const component = () => null;
  // Every register path, each given a definition that names itself but has no id.
  const kinds: Array<{
    kind: string;
    register: (contributions: RegistryContributions, id: unknown) => void;
    stored: (contributions: RegistryContributions) => number;
  }> = [
    { kind: "pane", register: (c, id) => c.registerPane("author", { id, name: "Pane", component, defaultPosition: "left" } as never), stored: (c) => c.panesMap.size },
    { kind: "pane template", register: (c, id) => c.registerPaneTemplate("author", { id, paneId: "pane", label: "Template" } as never), stored: (c) => c.paneTemplatesMap.size },
    { kind: "command", register: (c, id) => c.registerCommand("author", { id, label: "Command" } as never), stored: (c) => c.commandsMap.size },
    { kind: "command bar search provider", register: (c, id) => c.registerCommandBarSearchProvider("author", { id, name: "Provider" } as never), stored: (c) => c.commandBarSearchProvidersMap.size },
    { kind: "column", register: (c, id) => c.registerColumn("author", { id, name: "Column" } as never), stored: (c) => c.columnsMap.size },
    { kind: "broker", register: (c, id) => c.registerBroker("author", { id, name: "Broker" } as never), stored: (c) => c.brokersMap.size },
    { kind: "ticker research tab", register: (c, id) => c.registerTickerResearchTab("author", { id, name: "Tab", order: 1, component } as never), stored: (c) => c.tickerResearchTabsMap.size },
    { kind: "shortcut", register: (c, id) => c.registerShortcut("author", { id, name: "Shortcut" } as never), stored: (c) => c.shortcutsMap.size },
    { kind: "ticker action", register: (c, id) => c.registerTickerAction("author", { id, label: "Action" } as never), stored: (c) => c.tickerActionsMap.size },
    { kind: "context menu provider", register: (c, id) => c.registerContextMenuProvider("author", { id } as never), stored: (c) => c.contextMenuProvidersMap.size },
  ];

  test.each(kinds)("is refused for a $kind, with the plugin and kind named, and nothing is stored", ({ kind, register, stored }) => {
    const { contributions } = countingContributions();
    for (const id of [undefined, null, "", 7]) {
      expect(() => register(contributions, id), String(id)).toThrow(`Plugin "author" registered a ${kind}`);
      expect(stored(contributions), String(id)).toBe(0);
    }
    register(contributions, "ok");
    expect(stored(contributions)).toBe(1);
  });

  test("says what is wrong with the id and which contribution it is", () => {
    const { contributions } = countingContributions();
    const refusal = (definition: unknown) => {
      try {
        contributions.registerCommand("author", definition as never);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected the registration to be refused");
    };
    expect(refusal({ label: "Run it" })).toBe(
      'Plugin "author" registered a command ("Run it") that has no id. Give every command a non-empty string `id`.',
    );
    expect(refusal({ id: "", label: "Run it" })).toContain("that has an empty id");
    expect(refusal({ id: 3 })).toBe(
      'Plugin "author" registered a command that has an id that is not a string (number). Give every command a non-empty string `id`.',
    );
    expect(refusal(undefined)).toContain("that has no id");
  });
});
