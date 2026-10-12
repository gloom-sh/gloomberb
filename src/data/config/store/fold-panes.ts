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
const FILINGS_WORKSPACE_PANE_ID = "filings-workspace";
const EVENTS_WORKSPACE_PANE_ID = "events-workspace";

const FOLDED_PANE_TABS: Readonly<Record<string, { paneId: string; tab: string }>> = {
  sec: { paneId: FILINGS_WORKSPACE_PANE_ID, tab: "sec" },
  "risk-factors": { paneId: FILINGS_WORKSPACE_PANE_ID, tab: "risks" },
  "filing-events": { paneId: FILINGS_WORKSPACE_PANE_ID, tab: "eight-k" },
  "comment-letters": { paneId: FILINGS_WORKSPACE_PANE_ID, tab: "comments" },
  "corporate-actions": { paneId: EVENTS_WORKSPACE_PANE_ID, tab: "corporate-actions" },
  catalysts: { paneId: EVENTS_WORKSPACE_PANE_ID, tab: "catalysts" },
  litigation: { paneId: EVENTS_WORKSPACE_PANE_ID, tab: "litigation" },
  mna: { paneId: EVENTS_WORKSPACE_PANE_ID, tab: "mna" },
};

const FOLDED_RESEARCH_TABS: Readonly<Record<string, { workspace: string; tab: string }>> = {
  sec: { workspace: FILINGS_WORKSPACE_PANE_ID, tab: "sec" },
  "risk-factors": { workspace: FILINGS_WORKSPACE_PANE_ID, tab: "risks" },
  "filing-events": { workspace: FILINGS_WORKSPACE_PANE_ID, tab: "eight-k" },
  "corporate-actions": { workspace: EVENTS_WORKSPACE_PANE_ID, tab: "corporate-actions" },
  catalysts: { workspace: EVENTS_WORKSPACE_PANE_ID, tab: "catalysts" },
  mna: { workspace: EVENTS_WORKSPACE_PANE_ID, tab: "mna" },
};

interface FoldedLayout {
  layout: LayoutConfig;
  idMap: Map<string, string>;
  removed: Set<string>;
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
  return { ...node, first: mapNode(node.first, idMap)!, second: mapNode(node.second, idMap)! };
}

/** Find the legacy M&A pane's saved Deals or Distress view. */
function savedMnaTab(paneState: unknown): string | null {
  if (!isRecord(paneState) || !isRecord(paneState.pluginState)) return null;
  for (const namespace of ["ticker-research", "filings", "mna"]) {
    const state = paneState.pluginState[namespace];
    if (isRecord(state) && (state.tab === "deals" || state.tab === "distress")) return state.tab;
  }
  return null;
}

function foldedWorkspaceInstance(instance: PaneInstanceConfig, paneState: unknown): PaneInstanceConfig {
  if (instance.paneId === "ticker-research" && typeof instance.settings?.lockedTabId === "string") {
    const tab = FOLDED_RESEARCH_TABS[instance.settings.lockedTabId];
    if (tab) {
      return {
        ...instance,
        settings: {
          ...instance.settings,
          lockedTabId: tab.workspace,
          lockedWorkspaceTab: tab.tab,
        },
      };
    }
  }
  if (instance.paneId === "sec" && typeof instance.settings?.forms === "string" && instance.settings.forms.trim()) {
    return {
      ...instance,
      paneId: FILINGS_WORKSPACE_PANE_ID,
      params: { ...(instance.params ?? {}), tab: "etf" },
    };
  }

  const folded = FOLDED_PANE_TABS[instance.paneId];
  if (!folded) return instance;
  const tab = instance.paneId === "mna"
    && (instance.params?.tab === "distress" || savedMnaTab(paneState) === "distress")
    ? "distress"
    : folded.tab;
  return {
    ...instance,
    paneId: folded.paneId,
    params: { ...(instance.params ?? {}), tab },
  };
}

/** Version 25 folding: daily short volume and sovereign CDS only. */
export function foldPaneLayout(layout: LayoutConfig): FoldedLayout {
  const removed = new Set<string>();
  const idMap = new Map<string, string>();
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
      return { ...instance, binding, placementMemory };
    }),
    floating: layout.floating.map((entry) => ({ ...entry, instanceId: idMap.get(entry.instanceId) ?? entry.instanceId })),
    detached: (layout.detached ?? []).map((entry) => ({ ...entry, instanceId: idMap.get(entry.instanceId) ?? entry.instanceId })),
  };
  return { layout: removePaneInstances(mapped, removed), idMap, removed };
}

/** Fold issuer research panes into Filings and Events while retaining instance IDs. */
function foldFilingsEventsPaneLayout(layout: LayoutConfig, paneState?: unknown): LayoutConfig {
  return {
    ...layout,
    instances: layout.instances.map((instance) => {
      const state = isRecord(paneState) ? paneState[instance.instanceId] : undefined;
      return foldedWorkspaceInstance(instance, state);
    }),
  };
}

function foldPaneState(
  value: unknown,
  idMap: Map<string, string>,
  removed: Set<string>,
): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([instanceId]) => !removed.has(instanceId))
      .map(([instanceId, entry]) => [idMap.get(instanceId) ?? instanceId, entry]),
  );
}

function foldResearchTab(value: unknown): unknown {
  if (!isRecord(value) || typeof value.activeTabId !== "string") return value;
  const tab = FOLDED_RESEARCH_TABS[value.activeTabId];
  if (!tab) return value;
  const pluginState = isRecord(value.pluginState) ? value.pluginState : {};
  const namespace = isRecord(pluginState["ticker-research"]) ? pluginState["ticker-research"] : {};
  const stateKey = tab.workspace === FILINGS_WORKSPACE_PANE_ID ? "filings:tab" : "events:tab";
  return {
    ...value,
    activeTabId: tab.workspace,
    pluginState: {
      ...pluginState,
      "ticker-research": { ...namespace, [stateKey]: tab.tab },
    },
  };
}

function foldResearchTabState(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([instanceId, state]) => [instanceId, foldResearchTab(state)]),
  );
}

function foldFocus(value: unknown, idMap: Map<string, string>, removed: Set<string>): unknown {
  if (typeof value !== "string") return value;
  if (removed.has(value)) return null;
  return idMap.get(value) ?? value;
}

function foldLayoutField(value: unknown): FoldedLayout | null {
  const layout = asLayout(value);
  if (!layout) return null;
  return foldPaneLayout(layout);
}

/** Rewrite the open layout and every saved tab. */
export function foldSavedPanes(saved: Record<string, unknown>): Record<string, unknown> {
  const open = foldLayoutField(saved.layout);
  const layouts = Array.isArray(saved.layouts)
    ? saved.layouts.map((entry) => {
      if (!isRecord(entry)) return entry;
      const folded = foldLayoutField(entry.layout);
      if (!folded) return entry;
      return {
        ...entry,
        layout: folded.layout,
        paneState: foldPaneState(entry.paneState, folded.idMap, folded.removed),
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

function foldFilingsEventsLayoutField(value: unknown, paneState?: unknown): LayoutConfig | null {
  const layout = asLayout(value);
  return layout ? foldFilingsEventsPaneLayout(layout, paneState) : null;
}

/** Apply the version 27 Filings and Events migration without changing version 25 behavior. */
export function foldSavedFilingsEventsPanes(saved: Record<string, unknown>): Record<string, unknown> {
  const open = foldFilingsEventsLayoutField(saved.layout);
  const layouts = Array.isArray(saved.layouts)
    ? saved.layouts.map((entry) => {
      if (!isRecord(entry)) return entry;
      const layout = foldFilingsEventsLayoutField(entry.layout, entry.paneState);
      if (!layout) return entry;
      return {
        ...entry,
        layout,
        paneState: foldResearchTabState(entry.paneState),
      };
    })
    : saved.layouts;
  return {
    ...saved,
    ...(open ? { layout: open } : {}),
    layouts,
  };
}
