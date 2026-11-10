import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { PaneDef, TickerResearchTabDef } from "../../types/plugin";
import { getLoadablePlugins } from "../catalog";
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

  test("a component that fails to load fails where it is read, and is tried again", () => {
    const { contributions } = countingContributions();
    let attempts = 0;
    contributions.registerPane("owner", lazyPane("flaky", () => {
      if (++attempts === 1) throw new Error("module failed to load");
      return () => null;
    }));

    expect(() => contributions.panesMap.get("flaky")!.component).toThrow("module failed to load");
    expect(typeof contributions.panesMap.get("flaky")!.component).toBe("function");
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
  });
});
