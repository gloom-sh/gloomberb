import { afterAll, describe, expect, test } from "bun:test";
import { createPaneDiscoveryContext } from "../cli/pane-functions/discovery";
import { FUNCTION_HELP } from "../cli/pane-functions/function-help";
import { parseChartSpec } from "../plugins/builtin/chart-composer/chart-spec";
import { getSelectedBuiltinStudies } from "../plugins/builtin/chart-composer/studies";
import { browserBuiltinPlugins } from "../plugins/catalog-browser";
import { uiBuiltinPlugins } from "../plugins/catalog-ui";
import { createDefaultConfig, type DockLayoutNode } from "../types/config";
import type { GloomPlugin } from "../types/plugin";
import { buildDesk, DESK_KEYS, DESKS, deskTemplate, getDesk, type DeskCatalog, type DeskLayout } from "./desks";

const config = createDefaultConfig("/tmp/desks-test");
const started: GloomPlugin[] = [];
afterAll(() => {
  for (const plugin of started.splice(0).reverse()) plugin.dispose?.();
});

/** The panes and templates the app's own plugins register, as a host's registry holds them. */
async function builtInCatalog(plugins: readonly GloomPlugin[]): Promise<DeskCatalog> {
  const { panes, paneTemplates, ...context } = createPaneDiscoveryContext({ getConfig: () => config });
  for (const plugin of plugins) {
    for (const pane of plugin.panes ?? []) panes.set(pane.id, pane);
    for (const template of plugin.paneTemplates ?? []) paneTemplates.set(template.id, template);
    started.push(plugin);
    await plugin.setup?.({ ...context, registerCommand: () => {} });
  }
  return { panes, paneTemplates };
}

const terminalCatalog = builtInCatalog(uiBuiltinPlugins);
const webCatalog = builtInCatalog(browserBuiltinPlugins);

function dockPaneIds(node: DockLayoutNode | null): string[] {
  if (!node) return [];
  return node.kind === "pane" ? [node.instanceId] : [...dockPaneIds(node.first), ...dockPaneIds(node.second)];
}

function expectWholeLayout(layout: DeskLayout | null): asserts layout is DeskLayout {
  expect(layout).not.toBeNull();
  if (!layout) return;
  const ids = layout.layout.instances.map((instance) => instance.instanceId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(dockPaneIds(layout.layout.dockRoot).sort()).toEqual([...ids].sort());
  for (const instance of layout.layout.instances) {
    if (instance.binding?.kind === "follow") expect(ids).toContain(instance.binding.sourceInstanceId);
  }
  for (const id of Object.keys(layout.paneState ?? {})) expect(ids).toContain(id);
}

describe("desks", () => {
  test("every desk function is one of the app's own, with data on Free in the desk and Pro-only in its Pro row", async () => {
    const catalog = await terminalCatalog;
    const describeFunction = (fn: string) => ({
      fn,
      builtIn: !!deskTemplate(catalog, fn) && !!FUNCTION_HELP[fn],
      proOnly: FUNCTION_HELP[fn]?.data?.free === "Pro only",
    });
    expect(DESKS.map((desk) => desk.key)).toEqual([...DESK_KEYS]);
    for (const desk of DESKS) {
      expect(dockPaneIds(desk.dock).sort()).toEqual(desk.panes.map((_, index) => `p${index + 1}`).sort());
      for (const entry of desk.panes) {
        expect(describeFunction(entry.fn)).toEqual({ fn: entry.fn, builtIn: true, proOnly: false });
        if (entry.follows) expect(desk.panes[entry.follows - 1]).toBeDefined();
      }
      for (const entry of desk.pro ?? []) {
        expect(describeFunction(entry.fn)).toEqual({ fn: entry.fn, builtIn: true, proOnly: true });
      }
    }
  });

  test("every desk builds into one tiled tab, linked panes included, with and without its Pro row", async () => {
    const catalog = await terminalCatalog;
    for (const desk of DESKS) {
      for (const pro of [false, true]) {
        const layout = await buildDesk(desk, { catalog, config, company: "MSFT", pro });
        expectWholeLayout(layout);
        expect(layout.name).toBe(desk.name);
        expect(layout.layout.instances).toHaveLength(desk.panes.length + (pro ? desk.pro?.length ?? 0 : 0));
        expect(layout.layout.floating).toEqual([]);
      }
    }

    const equities = await buildDesk(getDesk("equities"), { catalog, config, company: "MSFT", pro: false });
    expectWholeLayout(equities);
    const [research, chart, financials] = equities.layout.instances;
    expect(research!.binding).toEqual({ kind: "fixed", symbol: "MSFT" });
    expect(chart!.binding).toEqual({ kind: "follow", sourceInstanceId: research!.instanceId });
    expect(financials!.binding).toEqual({ kind: "follow", sourceInstanceId: research!.instanceId });
    expect(financials!.title).toBeUndefined();

    const fx = await buildDesk(getDesk("fx"), { catalog, config, company: "MSFT", pro: false });
    expectWholeLayout(fx);
    const world = fx.layout.instances.find((instance) => instance.paneId === "yield-curve")!;
    expect(fx.paneState?.[world.instanceId]).toEqual({ pluginState: { macro: { "yield-curve:tab": "world" } } });

    const trading = await buildDesk(getDesk("active"), { catalog, config, company: "MSFT", pro: false });
    expectWholeLayout(trading);
    const intraday = parseChartSpec(trading.layout.instances[0]!.settings?.chartSpec);
    expect(intraday?.viewport.range).toBe("1D");
    expect(getSelectedBuiltinStudies(intraday!)).toEqual(["volume", "vwap"]);
  });

  test("the web build leaves out the functions it does not ship, and the rest of the desk closes up", async () => {
    const catalog = await webCatalog;
    for (const desk of DESKS) {
      const layout = await buildDesk(desk, { catalog, config, company: "MSFT", pro: true });
      expectWholeLayout(layout);
      const missing = [...desk.panes, ...desk.pro ?? []].filter((entry) => !deskTemplate(catalog, entry.fn));
      expect(layout.layout.instances.length).toBe(desk.panes.length + (desk.pro?.length ?? 0) - missing.length);
      // A desk keeps most of itself on the web; a function that went missing from it needs a look.
      expect({ desk: desk.key, missing: missing.length <= 1 }).toEqual({ desk: desk.key, missing: true });
    }
  });
});
