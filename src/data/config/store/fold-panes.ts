import {
  removePaneInstances,
  type DockLayoutNode,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../../../types/config";
import { isRecord } from "../../../utils/guards";

const SHORT_VOLUME_PANE_ID = "short-volume";
const SHORT_INTEREST_PANE_ID = "short-interest";
const SOVR_PANE_ID = "sovr-board";
const CDX_PANE_ID = "cdx-board";
const FIXED_INCOME_PANE_ID = "fixed-income";
const FIXED_INCOME_VIEW_STATE: Record<string, string> = {
  cds: "fixed-income:cds",
  [CDX_PANE_ID]: "fixed-income:credit-boards",
  "credit-conditions": "fixed-income:credit-conditions",
  "bond-calculator": "fixed-income:bond-calculator",
  "treasury-auctions": "fixed-income:treasury-auctions",
  "trace-bonds": "fixed-income:trace-bonds",
  "treasury-daily": "fixed-income:treasury-daily",
  "primary-dealers": "fixed-income:primary-dealers",
};

interface FixedIncomeRoute {
  section: "credit" | "issuer-debt" | "bonds" | "treasury";
  view: string;
  stateNamespace?: string;
  migrateCreditBoardTab?: boolean;
}

const COMMODITIES_ENERGY_PANE_ID = "commodities-energy";
const COMMODITIES_ENERGY_TABS: Readonly<Record<string, string>> = {
  futures: "markets",
  "futures-curve": "curve",
  cot: "positioning",
  doe: "inventories",
  "commodity-balances": "crops",
  jodi: "balances",
};
const COMMODITIES_MODULE_STATE: Readonly<Record<string, string>> = {
  "futures-curve": "market-overview:futures-curve",
  cot: "market-overview:cot",
  doe: "market-overview:doe",
};

interface FoldedLayout {
  layout: LayoutConfig;
  idMap: Map<string, string>;
  removed: Set<string>;
  fixedIncomeRoutes: Map<string, FixedIncomeRoute>;
}

function fixedIncomeRoute(instance: PaneInstanceConfig): FixedIncomeRoute | null {
  const stateNamespace = FIXED_INCOME_VIEW_STATE[instance.paneId];
  switch (instance.paneId) {
    case "cds": return { section: "credit", view: "single-name", stateNamespace };
    case CDX_PANE_ID:
      return {
        section: "credit",
        view: instance.params?.tab === "sovereign" ? "sovereign" : "index",
        stateNamespace,
        migrateCreditBoardTab: !instance.params?.tabAt,
      };
    case "credit-conditions": return { section: "credit", view: "spreads", stateNamespace };
    case "credit-documents": return { section: "issuer-debt", view: "documents" };
    case "debt-maturities": return { section: "issuer-debt", view: "maturities" };
    case "trace-bonds": return { section: "bonds", view: "tape", stateNamespace };
    case "bond-calculator": return { section: "bonds", view: "calculator", stateNamespace };
    case "treasury-auctions": return { section: "treasury", view: "auctions", stateNamespace };
    case "treasury-daily": return { section: "treasury", view: "cash-debt", stateNamespace };
    case "primary-dealers": return { section: "treasury", view: "dealers", stateNamespace };
    default: return null;
  }
}

function asLayout(value: unknown): LayoutConfig | null {
  if (!isRecord(value) || !Array.isArray(value.instances)) return null;
  return {
    dockRoot: (value.dockRoot ?? null) as DockLayoutNode | null,
    instances: value.instances as PaneInstanceConfig[],
    floating: Array.isArray(value.floating) ? value.floating as LayoutConfig["floating"] : [],
    detached: Array.isArray(value.detached) ? value.detached as LayoutConfig["detached"] : [],
  };
}

function interestInstanceId(instanceId: string): string {
  if (instanceId === SHORT_VOLUME_PANE_ID || instanceId.startsWith(`${SHORT_VOLUME_PANE_ID}:`)) {
    return `${SHORT_INTEREST_PANE_ID}${instanceId.slice(SHORT_VOLUME_PANE_ID.length)}`;
  }
  return instanceId;
}

function mapNode(node: DockLayoutNode | null, idMap: Map<string, string>): DockLayoutNode | null {
  if (!node) return null;
  if (node.kind === "pane") return { ...node, instanceId: idMap.get(node.instanceId) ?? node.instanceId };
  return {
    ...node,
    first: mapNode(node.first, idMap)!,
    second: mapNode(node.second, idMap)!,
    ...(node.tabs ? { tabs: { active: idMap.get(node.tabs.active) ?? node.tabs.active } } : {}),
  };
}

/** Daily short volume becomes the short interest pane's volume tab, and sovereign CDS the index board's Sovereign tab. */
export function foldPaneLayout(layout: LayoutConfig): FoldedLayout {
  const removed = new Set<string>();
  const idMap = new Map<string, string>();
  const fixedIncomeRoutes = new Map<string, FixedIncomeRoute>();
  const claimed = new Set(layout.instances.map((instance) => instance.instanceId));
  let hasIndexBoard = layout.instances.some((instance) => instance.paneId === CDX_PANE_ID);

  const instances = layout.instances.flatMap((instance) => {
    if (instance.paneId === SOVR_PANE_ID) {
      if (hasIndexBoard) {
        removed.add(instance.instanceId);
        return [];
      }
      hasIndexBoard = true;
      return [{
        ...instance,
        paneId: CDX_PANE_ID,
        params: { ...(instance.params ?? {}), tab: "sovereign" },
      }];
    }
    if (instance.paneId !== SHORT_VOLUME_PANE_ID) return [instance];
    const targetId = interestInstanceId(instance.instanceId);
    const taken = targetId !== instance.instanceId && claimed.has(targetId);
    if (taken) {
      removed.add(instance.instanceId);
      return [];
    }
    if (targetId !== instance.instanceId) {
      claimed.add(targetId);
      idMap.set(instance.instanceId, targetId);
    }
    return [{
      ...instance,
      instanceId: targetId,
      paneId: SHORT_INTEREST_PANE_ID,
      params: { ...(instance.params ?? {}), tab: "volume" },
    }];
  });

  const mapped: LayoutConfig = {
    dockRoot: mapNode(layout.dockRoot, idMap),
    instances: instances.map((instance) => {
      const binding = instance.binding?.kind === "follow"
        ? { ...instance.binding, sourceInstanceId: idMap.get(instance.binding.sourceInstanceId) ?? instance.binding.sourceInstanceId }
        : instance.binding;
      const anchor = instance.placementMemory?.docked?.anchorInstanceId;
      const placementMemory = anchor
        ? {
          ...instance.placementMemory,
          docked: { ...instance.placementMemory?.docked, anchorInstanceId: idMap.get(anchor) ?? anchor },
        }
        : instance.placementMemory;
      return {
        ...instance,
        binding,
        ...(placementMemory ? { placementMemory } : {}),
      };
    }),
    floating: layout.floating.map((entry) => ({ ...entry, instanceId: idMap.get(entry.instanceId) ?? entry.instanceId })),
    detached: (layout.detached ?? []).map((entry) => ({ ...entry, instanceId: idMap.get(entry.instanceId) ?? entry.instanceId })),
  };
  return { layout: removePaneInstances(mapped, removed), idMap, removed, fixedIncomeRoutes };
}

/** Apply the fixed-income rewrite after the original short-volume/SOVR fold. */
export function foldFixedIncomePaneLayout(layout: LayoutConfig): FoldedLayout {
  const folded = foldPaneLayout(layout);
  const fixedIncomeRoutes = new Map<string, FixedIncomeRoute>();
  const instances = folded.layout.instances.map((instance) => {
    const route = fixedIncomeRoute(instance);
    if (!route) return instance;
    fixedIncomeRoutes.set(instance.instanceId, route);
    // The old function's title (CDS AAPL, DDIS AAPL) would outlive its tab; the workspace names itself.
    const { title: _title, ...rest } = instance;
    return {
      ...rest,
      paneId: FIXED_INCOME_PANE_ID,
      params: { ...(instance.params ?? {}), tab: route.section, view: route.view },
    };
  });
  return {
    ...folded,
    layout: { ...folded.layout, instances },
    fixedIncomeRoutes,
  };
}

function foldPaneState(
  value: unknown,
  idMap: Map<string, string>,
  removed: Set<string>,
  fixedIncomeRoutes: Map<string, FixedIncomeRoute>,
): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([instanceId]) => !removed.has(instanceId))
      .map(([instanceId, entry]) => {
        const targetId = idMap.get(instanceId) ?? instanceId;
        const route = fixedIncomeRoutes.get(instanceId);
        if (!route || !isRecord(entry) || !isRecord(entry.pluginState)) return [targetId, entry];
        let pluginState = entry.pluginState;
        const macroState = pluginState.macro;
        if (route.stateNamespace && isRecord(macroState)) {
          const previousViewState = pluginState[route.stateNamespace];
          pluginState = {
            ...pluginState,
            [route.stateNamespace]: {
              ...macroState,
              ...(isRecord(previousViewState) ? previousViewState : {}),
            },
          };
        }
        if (!route.migrateCreditBoardTab || !isRecord(macroState) || typeof macroState["credit-boards:tab"] !== "string") {
          return [targetId, { ...entry, pluginState }];
        }
        const migratedMacroState = {
          ...macroState,
          "fixed-income:view:credit": macroState["credit-boards:tab"],
        };
        return [targetId, {
          ...entry,
          pluginState: { ...pluginState, macro: migratedMacroState },
        }];
      }),
  );
}

function foldFocus(value: unknown, idMap: Map<string, string>, removed: Set<string>): unknown {
  if (typeof value !== "string") return value;
  if (removed.has(value)) return null;
  return idMap.get(value) ?? value;
}

function foldLayoutField(
  value: unknown,
  foldLayout: (layout: LayoutConfig) => FoldedLayout,
): FoldedLayout | null {
  const layout = asLayout(value);
  return layout ? foldLayout(layout) : null;
}

function foldSavedPanesWith(
  saved: Record<string, unknown>,
  foldLayout: (layout: LayoutConfig) => FoldedLayout,
): Record<string, unknown> {
  const open = foldLayoutField(saved.layout, foldLayout);
  const layouts = Array.isArray(saved.layouts)
    ? saved.layouts.map((entry) => {
      if (!isRecord(entry)) return entry;
      const folded = foldLayoutField(entry.layout, foldLayout);
      if (!folded) return entry;
      return {
        ...entry,
        layout: folded.layout,
        paneState: foldPaneState(entry.paneState, folded.idMap, folded.removed, folded.fixedIncomeRoutes),
        focusedPaneId: foldFocus(entry.focusedPaneId, folded.idMap, folded.removed),
      };
    })
    : saved.layouts;
  return {
    ...saved,
    ...(open ? { layout: open.layout } : {}),
    layouts,
  };
}

/** Rewrite the open layout and every saved tab for the original pane fold. */
export function foldSavedPanes(saved: Record<string, unknown>): Record<string, unknown> {
  return foldSavedPanesWith(saved, foldPaneLayout);
}

/** Rewrite layouts for the Fixed Income workspace migration. */
export function foldFixedIncomeSavedPanes(saved: Record<string, unknown>): Record<string, unknown> {
  return foldSavedPanesWith(saved, foldFixedIncomePaneLayout);
}

/** Move related market and energy panes into the one Commodities & Energy workspace. */
export function foldCommoditiesPaneLayout(layout: LayoutConfig): LayoutConfig {
  const instances = layout.instances.map((instance) => {
    const tab = COMMODITIES_ENERGY_TABS[instance.paneId];
    if (!tab) return instance;
    // The old function's title (CTM NG, CFTC Positioning) would outlive its tab; the workspace names itself.
    const { title: _title, ...rest } = instance;
    return {
      ...rest,
      paneId: COMMODITIES_ENERGY_PANE_ID,
      params: { ...(instance.params ?? {}), tab },
    };
  });
  return { ...layout, instances };
}

function foldCommoditiesPaneState(value: unknown, layout: LayoutConfig): unknown {
  if (!isRecord(value)) return value;
  let next = value;
  for (const instance of layout.instances) {
    const stateId = COMMODITIES_MODULE_STATE[instance.paneId];
    if (!stateId) continue;
    const entry = next[instance.instanceId];
    if (!isRecord(entry) || !isRecord(entry.pluginState)) continue;
    const oldState = entry.pluginState["market-overview"];
    if (!isRecord(oldState)) continue;
    const pluginState = { ...entry.pluginState };
    pluginState[stateId] = {
      ...oldState,
      ...(isRecord(pluginState[stateId]) ? pluginState[stateId] : {}),
    };
    delete pluginState["market-overview"];
    next = { ...next, [instance.instanceId]: { ...entry, pluginState } };
  }
  return next;
}

function foldCommoditiesLayoutField(value: unknown): LayoutConfig | null {
  const layout = asLayout(value);
  return layout ? foldCommoditiesPaneLayout(layout) : null;
}

/** Rewrite old panes in the open layout and every saved layout, retaining the selected tab and module state. */
export function foldSavedCommoditiesPanes(saved: Record<string, unknown>): Record<string, unknown> {
  const open = foldCommoditiesLayoutField(saved.layout);
  const layouts = Array.isArray(saved.layouts)
    ? saved.layouts.map((entry) => {
      if (!isRecord(entry)) return entry;
      const original = asLayout(entry.layout);
      if (!original) return entry;
      return {
        ...entry,
        layout: foldCommoditiesPaneLayout(original),
        paneState: foldCommoditiesPaneState(entry.paneState, original),
      };
    })
    : saved.layouts;
  return {
    ...saved,
    ...(open ? { layout: open } : {}),
    layouts,
  };
}
