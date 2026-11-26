import { buildSplitAroundNode, getDockedInstanceIds } from "../../../layout/pane-manager/dock-tree";
import { normalizeDockNode } from "../../../layout/pane-manager/dock-normalization";
import type { DockLayoutNode } from "../../../types/config";
import { applyProfileEdits, diffProfile, sameProfileJson, type ProfileJson } from "../../profile-merge";
import { matchLegacyTabs, type LegacyTab } from "./legacy-tabs";

type JsonObject = { [key: string]: ProfileJson };
type TreeChange = { before: ProfileJson; after: ProfileJson };
type WorkspaceKey = string | null;

function isObject(value: ProfileJson | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The tree describes geometry, but dock membership is an independent edit per pane. */
function projectLayout(layout: ProfileJson, projectTree: (tree: ProfileJson) => ProfileJson): ProfileJson {
  if (!isObject(layout) || !Array.isArray(layout.instances) || !("dockRoot" in layout)) return layout;
  const tree = layout.dockRoot!;
  return { ...layout, dockRoot: { tree: projectTree(tree), members: getDockedInstanceIds(tree as unknown as DockLayoutNode | null) } };
}

/** A closed sibling changes every path in the promoted subtree. Compare all three trees in the surviving dock. */
function mergeTree(tree: ProfileJson, change: TreeChange, members: Set<string>): ProfileJson {
  if (sameProfileJson(tree, change.before)) return change.after;
  if (sameProfileJson(tree, change.after)) return tree;
  const surviving = (root: ProfileJson) => normalizeDockNode(root as unknown as DockLayoutNode | null, members, new Set()) as unknown as ProfileJson;
  return applyProfileEdits(surviving(tree), diffProfile(surviving(change.before), surviving(change.after)));
}

/** Keep explicit window placements and surviving splits. Only a dock member lost from the tree needs a new split. */
function restoreLayout(layout: ProfileJson, change: TreeChange | undefined): ProfileJson {
  if (!isObject(layout) || !Array.isArray(layout.instances) || !isObject(layout.dockRoot) || !Array.isArray(layout.dockRoot.members)) return layout;
  const available = new Set(layout.instances.flatMap((entry) => isObject(entry) ? [entry.instanceId] : []));
  const restored = { ...layout };
  for (const key of ["detached", "floating"]) {
    const entries = layout[key];
    if (Array.isArray(entries)) restored[key] = entries.filter((entry) => isObject(entry) && available.delete(entry.instanceId));
  }
  const members = new Set(layout.dockRoot.members.filter((id): id is string => typeof id === "string" && available.has(id)));
  const tree = change ? mergeTree(layout.dockRoot.tree!, change, members) : layout.dockRoot.tree;
  const placed = new Set<string>();
  let root = normalizeDockNode(tree as unknown as DockLayoutNode | null, members, placed);
  for (const id of members) {
    if (!placed.has(id)) root = root ? buildSplitAroundNode(root, id, "right") : { kind: "pane", instanceId: id };
  }
  return { ...restored, dockRoot: root as unknown as ProfileJson };
}

function selectedTab(config: JsonObject) {
  if (!Array.isArray(config.layouts) || typeof config.activeLayoutIndex !== "number") return undefined;
  const tab = config.layouts[config.activeLayoutIndex];
  return isObject(tab) ? tab : undefined;
}

function mirrorsSelectedTab(config: ProfileJson): boolean {
  return isObject(config) && config.layout !== undefined && sameProfileJson(config.layout, selectedTab(config)?.layout);
}

function legacyTabs(config: ProfileJson): LegacyTab[] {
  if (!isObject(config) || !Array.isArray(config.layouts)) return [];
  return config.layouts.flatMap((tab, index) => {
    if (!isObject(tab) || typeof tab.id === "string") return [];
    const instances = isObject(tab.layout) && Array.isArray(tab.layout.instances) ? tab.layout.instances : [];
    const panes = new Set(instances.flatMap((entry) => isObject(entry) && typeof entry.instanceId === "string" ? [entry.instanceId] : []));
    return [{ index, name: String(tab.name), panes }];
  });
}

/** Selection uses the row's merge key. Uncertain replacements carry a whole candidate per writer, not editable pane fields. */
function projectConfig(config: ProfileJson, baseTabs: LegacyTab[], side: "base" | "incoming" | "local", projectTree = (_key: WorkspaceKey, tree: ProfileJson) => tree): ProfileJson {
  if (!isObject(config)) return config;
  const result = { ...config };
  if (config.layout !== undefined) result.layout = projectLayout(config.layout, (tree) => projectTree(null, tree));
  if (Array.isArray(config.layouts)) {
    const legacy = side === "base" ? undefined : matchLegacyTabs(baseTabs, legacyTabs(config));
    result.layouts = config.layouts.map((tab, index) => {
      if (!isObject(tab)) return tab;
      const match = legacy?.get(index);
      const id = typeof tab.id === "string" ? `id:${tab.id}` : match?.key ?? `legacy:${index}`;
      if (match?.whole) return { id, [side]: tab };
      const projected = { ...tab };
      if (tab.layout !== undefined) projected.layout = projectLayout(tab.layout, (tree) => projectTree(id, tree));
      return { id, tab: projected };
    });
    const selected = selectedTab(result);
    if (selected) result.activeLayoutIndex = selected.id!;
  }
  return result;
}

function restoreConfig(config: ProfileJson, trees: Map<WorkspaceKey, TreeChange>, mirror: boolean): ProfileJson {
  if (!isObject(config)) return config;
  const result = { ...config };
  if (Array.isArray(config.layouts)) {
    if (typeof config.activeLayoutIndex === "string") {
      result.activeLayoutIndex = Math.max(0, config.layouts.findIndex((tab) => isObject(tab) && tab.id === config.activeLayoutIndex));
    }
    result.layouts = config.layouts.map((entry) => {
      if (!isObject(entry) || typeof entry.id !== "string") return entry;
      if (entry.local !== undefined) return entry.local;
      if (entry.incoming !== undefined) return entry.incoming;
      const tab = entry.tab!;
      return isObject(tab) && tab.layout !== undefined ? { ...tab, layout: restoreLayout(tab.layout, trees.get(entry.id)) } : tab;
    });
  }
  if (config.layout !== undefined) {
    const selectedLayout = mirror ? selectedTab(result)?.layout : undefined;
    result.layout = selectedLayout ?? restoreLayout(config.layout, trees.get(null));
  }
  return result;
}

/** Replay the same config delta on a stale save and on the live app before either normalizes away unreachable panes. */
export function diffSharedConfig(before: ProfileJson, after: ProfileJson) {
  const baseTabs = legacyTabs(before);
  const original = new Map<WorkspaceKey, ProfileJson>();
  const trees = new Map<WorkspaceKey, TreeChange>();
  const base = projectConfig(before, baseTabs, "base", (key, tree) => {
    original.set(key, tree);
    return tree;
  });
  const next = projectConfig(after, baseTabs, "incoming", (key, tree) => {
    const prior = original.get(key);
    if (prior === undefined) return tree;
    if (!sameProfileJson(prior, tree)) trees.set(key, { before: prior, after: tree });
    return prior;
  });
  const changes = diffProfile(base, next);
  const tabOrder = changes.find(({ kind, path: [root, child] }) =>
    kind === "order" && !child && root && "key" in root && root.key === "layouts");
  const edits = tabOrder ? [tabOrder, ...changes.filter((change) => change !== tabOrder)] : changes;
  const workspaceEdit = trees.size > 0 || edits.some(({ path: [root] }) =>
    !root || ("key" in root && ["layout", "layouts", "activeLayoutIndex"].includes(root.key)));
  const mirror = workspaceEdit && mirrorsSelectedTab(before) && mirrorsSelectedTab(after);
  return {
    count: edits.length + trees.size,
    apply<T extends ProfileJson>(config: T): T {
      if (!workspaceEdit) return applyProfileEdits(config, edits);
      const projected = projectConfig(config, baseTabs, "local");
      const merged = applyProfileEdits(projected, edits);
      if (merged === projected && !trees.size) return config;
      const restored = restoreConfig(merged, trees, mirror && mirrorsSelectedTab(config));
      return merged === projected && sameProfileJson(restored, config) ? config : restored as T;
    },
  };
}
