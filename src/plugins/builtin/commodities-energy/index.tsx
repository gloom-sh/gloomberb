import { useCallback, useEffect, useState, type ComponentType } from "react";
import { NestedPaneTabs, PaneFooterScope, usePaneTabs } from "../../../components";
import { usePaneSettingValue } from "../../../state/app/context";
import { Box } from "../../../ui";
import type { PaneProps, PaneSettingsContext, PaneTemplateContext, PaneTemplateCreateOptions, PaneTemplateDef, PaneTemplateInstanceConfig } from "../../../types/plugin";
import { withPluginStateNamespace } from "../../runtime/context";
import { useCommandTab, withCommandTab } from "../shared/command-tab";
import { commodityBalancesModule } from "../commodity-balances";
import { CommodityBalancesPane } from "../commodity-balances/pane";
import { cotModule } from "../cot";
import { CotPane } from "../cot/pane";
import { doeModule } from "../doe";
import { DoePane } from "../doe/pane";
import { FuturesPane, futuresModule } from "../futures";
import { FuturesCurvePane } from "../futures-curve/pane";
import { futuresCurveModule } from "../futures-curve";
import { JodiPane } from "../jodi/pane";
import { jodiModule } from "../jodi";
import type { PluginModule } from "../plugin-module";

const COMMODITIES_ENERGY_PANE_ID = "commodities-energy";
const COMMODITIES_ENERGY_TITLE = "Commodities & Energy";

const TABS = [
  { value: "markets", label: "Markets" },
  { value: "curve", label: "Curve" },
  { value: "positioning", label: "Positioning" },
  { value: "inventories", label: "Inventories" },
  { value: "crops", label: "Crops" },
  { value: "balances", label: "Oil & Gas" },
] as const;
type WorkspaceTab = typeof TABS[number]["value"];

const CURVE_SURFACE = withPluginStateNamespace("market-overview:futures-curve", FuturesCurvePane);
const COT_SURFACE = withPluginStateNamespace("market-overview:cot", CotPane);
const DOE_SURFACE = withPluginStateNamespace("market-overview:doe", DoePane);
const CROP_SURFACE = withPluginStateNamespace("commodity-balances", CommodityBalancesPane);
const JODI_SURFACE = withPluginStateNamespace("jodi", JodiPane);

const SURFACES = {
  markets: FuturesPane,
  curve: CURVE_SURFACE,
  positioning: COT_SURFACE,
  inventories: DOE_SURFACE,
  crops: CROP_SURFACE,
  balances: JODI_SURFACE,
} satisfies Record<WorkspaceTab, ComponentType<PaneProps>>;

/** One workspace tab from one of the previous pane templates. */
function workspaceTemplate(
  template: PaneTemplateDef,
  tab: WorkspaceTab,
  options: { browse?: boolean; label?: string; description?: string; keywords?: string[] } = {},
): PaneTemplateDef {
  const routed = withCommandTab(template, tab);
  const createInstance = routed.createInstance;
  return {
    ...routed,
    paneId: COMMODITIES_ENERGY_PANE_ID,
    ...(options.label ? { label: options.label } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.keywords ? { keywords: [...new Set([...(routed.keywords ?? []), ...options.keywords])] } : {}),
    ...(routed.shortcut ? {
      shortcut: {
        ...routed.shortcut,
        ...(options.browse === false ? { showInBrowse: false } : {}),
      },
    } : {}),
    createInstance: (context: PaneTemplateContext, createOptions?: PaneTemplateCreateOptions) => {
      const requested = createInstance?.(context, createOptions);
      const existing = reusableWorkspace(context);
      // One window for every tab: the old functions' titles (CTM CL, CFTC Positioning) would outlive their tab.
      const reuse = (instance: PaneTemplateInstanceConfig | null) => instance
        ? { ...instance, instanceId: existing?.instanceId ?? instance.instanceId, title: COMMODITIES_ENERGY_TITLE }
        : null;
      return requested instanceof Promise ? requested.then(reuse) : reuse(requested ?? {});
    },
  };
}

function reusableWorkspace(context: PaneTemplateContext) {
  return context.layout.instances.find((instance) => instance.instanceId === context.focusedPaneId
    && instance.paneId === COMMODITIES_ENERGY_PANE_ID)
    ?? context.layout.instances.find((instance) => instance.paneId === COMMODITIES_ENERGY_PANE_ID);
}

function templateFor(module: PluginModule, id: string): PaneTemplateDef {
  const template = module.paneTemplates?.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`Missing commodities workspace template: ${id}`);
  return template;
}

const futuresTemplate = templateFor(futuresModule, "futures-pane");
const curveTemplate = templateFor(futuresCurveModule, "futures-curve-pane");
const cotTemplate = templateFor(cotModule, "cot-cot");
const doeTemplate = templateFor(doeModule, "doe-pane");
const gasTemplate = templateFor(doeModule, "doe-gas-pane");
const cropsTemplate = templateFor(commodityBalancesModule, "commodity-balances-pane");
const jodiTemplate = templateFor(jodiModule, "jodi-pane");

const workspaceTemplates = [
  workspaceTemplate(futuresTemplate, "markets", {
    label: "Commodities & Energy",
    description: "Futures markets, curves, positioning, inventories, crop balances, and oil and gas balances.",
    keywords: ["commodities", "energy", "futures", "crude", "oil", "gas", "agriculture", "crops", "CFTC", "EIA", "balances"],
  }),
  workspaceTemplate(curveTemplate, "curve", { browse: false }),
  workspaceTemplate(cotTemplate, "positioning", { browse: false }),
  workspaceTemplate(doeTemplate, "inventories", { browse: false }),
  workspaceTemplate(gasTemplate, "inventories", { browse: false }),
  workspaceTemplate(cropsTemplate, "crops", { browse: false }),
  workspaceTemplate(jodiTemplate, "balances", { browse: false }),
];

function activeSettings(context: PaneSettingsContext) {
  const selectedTab = (context.settings.workspaceTab ?? context.pane.params?.tab ?? "markets") as WorkspaceTab;
  const pane = selectedTab === "markets" ? futuresModule.panes?.[0]
    : selectedTab === "curve" ? futuresCurveModule.panes?.[0]
      : null;
  if (!pane?.settings) return null;
  return typeof pane.settings === "function" ? pane.settings(context) : pane.settings;
}

function CommoditiesEnergyPane(props: PaneProps) {
  const [tab, setTab] = useCommandTab(
    COMMODITIES_ENERGY_PANE_ID,
    "commodities-energy:tab",
    TABS.map(({ value }) => value),
    "markets",
  );
  const [settingsTab, setSettingsTab] = usePaneSettingValue<WorkspaceTab>("workspaceTab", "markets");
  const [mounted, setMounted] = useState<Set<WorkspaceTab>>(() => new Set([tab]));
  useEffect(() => {
    setMounted((current) => current.has(tab) ? current : new Set([...current, tab]));
    if (settingsTab !== tab) setSettingsTab(tab);
  }, [setSettingsTab, settingsTab, tab]);
  const onSelect = useCallback((value: string) => {
    const next = TABS.some((entry) => entry.value === value) ? value as WorkspaceTab : "markets";
    setTab(next);
    setSettingsTab(next);
  }, [setSettingsTab, setTab]);
  const { strip, rows } = usePaneTabs({ tabs: [...TABS], activeValue: tab, onSelect, focused: props.focused, dense: true });
  const bodyHeight = Math.max(1, props.height - rows);

  return (
    <Box width={props.width} height={props.height} flexDirection="column" overflow="hidden">
      {strip}
      {TABS.map(({ value }) => {
        if (!mounted.has(value)) return null;
        const Surface = SURFACES[value];
        const active = value === tab;
        return (
          <Box key={value} visible={active} height={bodyHeight} flexGrow={1} flexBasis={0} overflow="hidden">
            <PaneFooterScope active={active}>
              <NestedPaneTabs>
                <Surface {...props} height={bodyHeight} focused={props.focused && active} />
              </NestedPaneTabs>
            </PaneFooterScope>
          </Box>
        );
      })}
    </Box>
  );
}

export const commoditiesEnergyModule: PluginModule = {
  panes: [{
    id: COMMODITIES_ENERGY_PANE_ID,
    name: "Commodities & Energy",
    icon: "C",
    component: CommoditiesEnergyPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 110, height: 32 },
    tableExport: true,
    settings: activeSettings,
  }],
  paneTemplates: workspaceTemplates,
};
