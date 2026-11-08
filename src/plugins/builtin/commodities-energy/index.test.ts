import { expect, test } from "bun:test";
import { retargetPaneInstance } from "../../../components/command-bar/workflow/pane-reuse";
import { createDefaultConfig } from "../../../types/config";
import type { PaneInstanceConfig } from "../../../types/config";
import type { PaneTemplateContext } from "../../../types/plugin";
import { normalizeCurveRoot, paneCurveRoot } from "../futures-curve/model";
import { buildHelpFunctionIndex, helpFunctionForPane } from "../help/function-index";
import { commoditiesEnergyModule } from ".";

const curveTemplate = commoditiesEnergyModule.paneTemplates!.find((template) => template.id === "futures-curve-pane")!;

/** The open workspace on its Curve tab, its root left at XAZ by the Markets board's search ("VI" finds Communication Services). */
function workspaceOn(root: string): { context: PaneTemplateContext; pane: PaneInstanceConfig } {
  const config = createDefaultConfig("/tmp/gloomberb-commodities-curve-root");
  const pane = {
    instanceId: "commodities-energy:main", paneId: "commodities-energy", title: `Curve \u00b7 ${root}`,
    binding: { kind: "none" }, params: { tab: "curve", root: "ES" }, settings: { workspaceTab: "curve", root },
  } as PaneInstanceConfig;
  const layout = { ...config.layout, instances: [pane] };
  return { context: { config: { ...config, layout }, layout, focusedPaneId: pane.instanceId, activeTicker: null, activeCollectionId: null }, pane };
}

async function run(context: PaneTemplateContext, pane: PaneInstanceConfig, arg?: string) {
  const spec = await curveTemplate.createInstance!(context, arg ? { arg } : undefined);
  const next = retargetPaneInstance(pane, spec!) ?? pane;
  return { title: next.title, root: normalizeCurveRoot(paneCurveRoot(next)) };
}

test("a root the command names wins over the board's, and the title names the root the body draws", async () => {
  const { context, pane } = workspaceOn("XAZ");
  expect(await run(context, pane, "VX")).toEqual({ title: "Curve \u00b7 VX", root: "VX" });
  expect(await run(context, pane, "vix")).toEqual({ title: "Curve \u00b7 VX", root: "VX" });
  // A bare CTM keeps the root the window shows, and its title still names it.
  expect(await run(context, pane)).toEqual({ title: "Curve \u00b7 XAZ", root: "XAZ" });
});

test("the workspace's ? explains the tab it shows: CTM on the curve, FUT on the board", () => {
  const index = buildHelpFunctionIndex({ commands: [], pluginCommands: [], paneTemplates: commoditiesEnergyModule.paneTemplates! });
  const panes = new Map(commoditiesEnergyModule.panes!.map((pane) => [pane.id, pane]));
  const registry = { panes, paneTemplates: new Map(), allPlugins: new Map(), getPanePluginId: () => null, getPaneTemplatePluginId: () => null } as never;
  const { pane } = workspaceOn("VX");
  expect(helpFunctionForPane(index, registry, pane)?.code).toBe("CTM");
  expect(helpFunctionForPane(index, registry, { ...pane, title: "Commodities & Energy", settings: { workspaceTab: "markets" } })?.code).toBe("FUT");
  expect(helpFunctionForPane(index, registry, { ...pane, settings: { workspaceTab: "positioning" } })?.code).toBe("COT");
});
