import {
  getPlacedPaneInstanceIds,
  type DockLayoutNode,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../types/config";

export function requirePaneInstance(layout: LayoutConfig, paneId: string): PaneInstanceConfig {
  const instance = layout.instances.find((entry) => entry.instanceId === paneId)
    ?? layout.instances.find((entry) => entry.paneId === paneId);
  if (!instance) throw new Error(`Unknown pane "${paneId}".`);
  return instance;
}

export function buildGridDockRoot(paneIds: string[], columns?: number): DockLayoutNode | null {
  if (paneIds.length === 0) return null;
  const columnCount = Math.max(1, Math.min(
    paneIds.length,
    Number.isInteger(columns) && columns! > 0 ? columns! : Math.ceil(Math.sqrt(paneIds.length)),
  ));
  const rows: DockLayoutNode[] = [];
  for (let index = 0; index < paneIds.length; index += columnCount) {
    rows.push(buildSplit(
      paneIds.slice(index, index + columnCount).map((instanceId) => ({ kind: "pane", instanceId })),
      "horizontal",
    ));
  }
  return buildSplit(rows, "vertical");
}

export function visiblePaneIds(layout: LayoutConfig): string[] {
  return getPlacedPaneInstanceIds(layout);
}

export function regionToDockPosition(region: string): "left" | "right" | "above" | "below" {
  if (region === "left" || region === "right") return region;
  if (region === "top") return "above";
  if (region === "bottom") return "below";
  throw new Error(`Unsupported dock region "${region}".`);
}

export function regionToRootEdge(region: string): "left" | "right" | "top" | "bottom" {
  if (region === "left" || region === "right" || region === "top" || region === "bottom") return region;
  throw new Error(`Unsupported root-edge region "${region}".`);
}

function buildSplit(nodes: DockLayoutNode[], axis: "horizontal" | "vertical"): DockLayoutNode {
  if (nodes.length === 0) throw new Error("Cannot build an empty dock split.");
  if (nodes.length === 1) return nodes[0]!;
  const splitIndex = Math.ceil(nodes.length / 2);
  const firstNodes = nodes.slice(0, splitIndex);
  const secondNodes = nodes.slice(splitIndex);
  return {
    kind: "split",
    axis,
    ratio: firstNodes.length / nodes.length,
    first: buildSplit(firstNodes, axis),
    second: buildSplit(secondNodes, axis),
  };
}
