import { buildSplitAroundNode, getDockedInstanceIds } from "../../../layout/pane-manager/dock-tree";
import { normalizeDockNode, type DockLayoutNode } from "../../../types/config";
import { applyProfileEdits, diffProfile, sameProfileJson, type ProfileJson } from "../../profile-merge";

type JsonObject = { [key: string]: ProfileJson };

function isObject(value: ProfileJson | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The tree describes geometry, but dock membership is an independent edit per pane. */
function projectLayout(layout: ProfileJson): ProfileJson {
  if (!isObject(layout) || !Array.isArray(layout.instances) || !("dockRoot" in layout)) return layout;
  const tree = layout.dockRoot!;
  return { ...layout, dockRoot: { tree, members: getDockedInstanceIds(tree as unknown as DockLayoutNode | null) } };
}

/** Keep explicit window placements and surviving splits. Only a dock member lost from the tree needs a new split. */
function restoreLayout(layout: ProfileJson): ProfileJson {
  if (!isObject(layout) || !Array.isArray(layout.instances) || !isObject(layout.dockRoot) || !Array.isArray(layout.dockRoot.members)) return layout;
  const tree = layout.dockRoot.tree as unknown as DockLayoutNode | null;
  const available = new Set(layout.instances.flatMap((entry) => isObject(entry) ? [entry.instanceId] : []));
  const restored = { ...layout };
  for (const key of ["detached", "floating"]) {
    const entries = layout[key];
    if (Array.isArray(entries)) restored[key] = entries.filter((entry) => isObject(entry) && available.delete(entry.instanceId));
  }
  const members = new Set(layout.dockRoot.members.filter((id): id is string => typeof id === "string" && available.has(id)));
  const placed = new Set<string>();
  let root = normalizeDockNode(tree, members, placed);
  for (const id of members) {
    if (!placed.has(id)) root = root ? buildSplitAroundNode(root, id, "right") : { kind: "pane", instanceId: id };
  }
  return { ...restored, dockRoot: root as unknown as ProfileJson };
}

/** Legacy tabs have no id. Only match them by position while all copies agree on the tab list. */
function tabSlots(config: ProfileJson): ProfileJson[] | null {
  if (!isObject(config) || !Array.isArray(config.layouts) || !config.layouts.some((tab) => isObject(tab) && !tab.id)) return null;
  return config.layouts.map((tab) => isObject(tab) ? [tab.id ?? null, tab.name ?? null] : null);
}

function mapLayouts(config: ProfileJson, direction: "project" | "restore", bySlot: boolean): ProfileJson {
  if (!isObject(config)) return config;
  const map = direction === "project" ? projectLayout : restoreLayout;
  const result = { ...config };
  if (config.layout !== undefined) result.layout = map(config.layout);
  const tabs = bySlot && direction === "restore" && isObject(config.layouts) ? Object.values(config.layouts) : config.layouts;
  if (Array.isArray(tabs)) {
    const mapped = tabs.map((tab) => isObject(tab) && tab.layout !== undefined ? { ...tab, layout: map(tab.layout) } : tab);
    result.layouts = bySlot && direction === "project" ? Object.fromEntries(mapped.entries()) : mapped;
  }
  return result;
}

/** Replay the same config delta on a stale save and on the live app before either normalizes away unreachable panes. */
export function diffSharedConfig(before: ProfileJson, after: ProfileJson) {
  const slots = tabSlots(before);
  const positional = slots !== null && sameProfileJson(slots, tabSlots(after));
  const edits = diffProfile(mapLayouts(before, "project", positional), mapLayouts(after, "project", positional));
  const workspaceEdit = edits.some(({ path: [root] }) => !root || ("key" in root && (root.key === "layout" || root.key === "layouts")));
  return {
    count: edits.length,
    apply<T extends ProfileJson>(config: T): T {
      if (!workspaceEdit) return applyProfileEdits(config, edits);
      const matchSlots = positional && sameProfileJson(slots, tabSlots(config));
      const projected = mapLayouts(config, "project", matchSlots);
      const merged = applyProfileEdits(projected, edits);
      return merged === projected ? config : mapLayouts(merged, "restore", matchSlots) as T;
    },
  };
}
