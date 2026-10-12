import { describe, expect, test } from "bun:test";
import { createPaneInstance, findPaneInstance, type LayoutConfig } from "../../types/config";
import { resolveShellVisibleLayout } from "../../components/layout/shell/visible-layout";
import { findDockLeaf, getNodeAtPath } from "./dock-tree";
import { applyDrop } from "./docking";
import { restoreHiddenPanes } from "./hidden-panes";
import { removePane } from "./layout-state";

const HIDDEN_TYPES = new Set(["cds", "econ"]);
const isHidden = (instance: { paneId: string }) => HIDDEN_TYPES.has(instance.paneId);
const show = (layout: LayoutConfig) => resolveShellVisibleLayout(layout, HIDDEN_TYPES, () => true);

/**
 * Credit and macro panes hidden at three depths of the dock tree, one stacked
 * under a list, plus a hidden floating window and a hidden popped-out one.
 */
function savedLayout(): LayoutConfig {
  return {
    dockRoot: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.3,
      first: {
        kind: "split",
        axis: "vertical",
        ratio: 0.62,
        first: { kind: "pane", instanceId: "list" },
        second: { kind: "pane", instanceId: "cds" },
      },
      second: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.55,
        first: { kind: "pane", instanceId: "eco" },
        second: {
          kind: "split",
          axis: "vertical",
          ratio: 0.4,
          first: { kind: "pane", instanceId: "des" },
          second: {
            kind: "split",
            axis: "horizontal",
            ratio: 0.7,
            first: { kind: "pane", instanceId: "map" },
            second: { kind: "pane", instanceId: "eco-2" },
          },
        },
      },
    },
    instances: [
      createPaneInstance("portfolio-list", { instanceId: "list" }),
      createPaneInstance("cds", { instanceId: "cds", binding: { kind: "fixed", symbol: "F" }, settings: { tenor: "10Y" } }),
      createPaneInstance("econ", { instanceId: "eco", params: { country: "JP" } }),
      createPaneInstance("ticker-detail", { instanceId: "des", binding: { kind: "fixed", symbol: "AAPL" } }),
      createPaneInstance("world-venue-map", { instanceId: "map" }),
      createPaneInstance("econ", { instanceId: "eco-2" }),
      createPaneInstance("chat", { instanceId: "chat" }),
      createPaneInstance("cds", { instanceId: "cds-float", binding: { kind: "fixed", symbol: "GM" } }),
      createPaneInstance("alerts", { instanceId: "alerts" }),
      createPaneInstance("econ", { instanceId: "eco-out" }),
    ],
    floating: [
      { instanceId: "chat", x: 4, y: 3, width: 40, height: 12, zIndex: 51 },
      { instanceId: "cds-float", x: 60, y: 8, width: 48, height: 16, zIndex: 53 },
      { instanceId: "alerts", x: 20, y: 20, width: 30, height: 10, zIndex: 52 },
    ],
    detached: [{ instanceId: "eco-out", x: 900, y: 120, width: 720, height: 480 }],
  };
}

function hiddenParts(layout: LayoutConfig) {
  return {
    instances: layout.instances.filter(isHidden),
    floating: layout.floating.filter((entry) => entry.instanceId === "cds-float"),
    detached: layout.detached.filter((entry) => entry.instanceId === "eco-out"),
  };
}

describe("restoreHiddenPanes", () => {
  test("an edit that leaves the shown panes as they were saves the layout unchanged", () => {
    const saved = savedLayout();
    expect(restoreHiddenPanes(saved, show(saved), isHidden)).toEqual(saved);
  });

  test("closing and moving shown panes keeps every hidden pane, beside the panes it sat next to", () => {
    const saved = savedLayout();
    const moved = applyDrop(removePane(show(saved), "des"), "map", { kind: "frame", edge: "bottom" });
    const edited = removePane(moved, "alerts");
    const restored = restoreHiddenPanes(saved, edited, isHidden);

    expect(hiddenParts(restored)).toEqual(hiddenParts(saved));
    // What is on screen is exactly what the edit left.
    expect(show(restored)).toEqual(edited);
    // Credit is still stacked under the list, at the same share of it.
    const cds = getNodeAtPath(restored.dockRoot, findDockLeaf(restored, "cds")!.path.slice(0, -1));
    expect(cds).toMatchObject({ axis: "vertical", ratio: 0.62, first: { instanceId: "list" }, second: { instanceId: "cds" } });
    // The macro pane that sat beside the moved map is still beside it.
    const eco2 = getNodeAtPath(restored.dockRoot, findDockLeaf(restored, "eco-2")!.path.slice(0, -1));
    expect(eco2).toMatchObject({ axis: "horizontal", ratio: 0.7, first: { instanceId: "map" } });
  });

  test("a hidden pane the edit already holds is not added a second time", () => {
    const saved = savedLayout();
    const edited = show(saved);
    edited.instances.push(findPaneInstance(saved, "cds-float")!);
    edited.floating.push(saved.floating[1]!);
    const restored = restoreHiddenPanes(saved, edited, isHidden);
    expect(restored.instances.filter((instance) => instance.instanceId === "cds-float")).toHaveLength(1);
    expect(restored.floating.filter((entry) => entry.instanceId === "cds-float")).toHaveLength(1);
  });
});
