import { describe, expect, test } from "bun:test";
import type { LayoutConfig } from "../../types/config";
import { addPaneToLayout, getDockLeafLayouts } from "../../layout/pane-manager";
import { gridDockTarget, resolvePaneShowTarget, utilityWindowsOf } from "./layout-placement";

describe("resolvePaneShowTarget", () => {
  test("resolves a hidden pane by its exact instance id", () => {
    const hiddenPane = {
      instanceId: "news-top:stored",
      paneId: "news-top",
      binding: { kind: "none" as const },
      placementMemory: {
        floating: { x: 12, y: 4, width: 90, height: 30 },
      },
    };
    const layout: LayoutConfig = {
      dockRoot: null,
      instances: [hiddenPane],
      floating: [],
      detached: [],
    };

    expect(resolvePaneShowTarget(layout, hiddenPane.instanceId)).toEqual({
      paneType: "news-top",
      instance: hiddenPane,
    });
  });
});

// A layout built from empty opened its four panes as floating windows stacked on one another; only Tidy Windows docked them.
test("panes added to a layout built from empty dock into an even grid; a layout with a floating window keeps floating new ones", () => {
  const empty: LayoutConfig = { dockRoot: null, instances: [], floating: [], detached: [] };
  const size = { width: 100, height: 40 };
  const grids = new Set<string>();
  const config = (layout: LayoutConfig) => ({ layout, layouts: [{ id: "frontier", name: "Frontier", layout }], activeLayoutIndex: 0 });
  let layout = empty;
  for (const paneId of ["portfolio-list", "econ-calendar", "central-bank-rates", "fixed-income"]) {
    const instance = { instanceId: `${paneId}:1`, paneId, binding: { kind: "none" as const } };
    const target = gridDockTarget(grids, config(layout), instance.instanceId, size);
    expect(target).not.toBeNull();
    layout = addPaneToLayout(layout, instance, target!);
  }
  const leaves = getDockLeafLayouts(layout, { x: 0, y: 0, ...size });
  // Two by two, every pane half the width and half the height: no column thinner than the rest.
  expect(leaves.map((leaf) => [leaf.instanceId, leaf.rect.width >= 49 && leaf.rect.width <= 51, leaf.rect.height >= 19 && leaf.rect.height <= 21]))
    .toEqual([
      ["portfolio-list:1", true, true], ["central-bank-rates:1", true, true],
      ["econ-calendar:1", true, true], ["fixed-income:1", true, true],
    ]);
  // A layout this window did not start from empty, or one with a floating window, opens new panes floating as before.
  expect(gridDockTarget(new Set(), config(layout), "news:1", size)).toBeNull();
  const withWindow = { ...layout, floating: [{ instanceId: "news:1", x: 1, y: 1, width: 40, height: 12 }] };
  expect(gridDockTarget(grids, config(withWindow), "quote:1", size)).toBeNull();
});

test("a utility window open over the layout neither stops its grid nor counts as one of its panes", () => {
  const size = { width: 100, height: 40 };
  const utility = (paneId: string) => ["account-management", "askg"].includes(paneId);
  const account = { instanceId: "account-management:1", paneId: "account-management", binding: { kind: "none" as const } };
  const window = (instanceId: string) => ({ instanceId, x: 2, y: 2, width: 60, height: 20 });
  // An empty layout with the account window open is still empty: the first pane added starts the grid.
  const opened: LayoutConfig = { dockRoot: null, instances: [account], floating: [window(account.instanceId)], detached: [] };
  const grids = new Set<string>();
  const config = (layout: LayoutConfig) => ({ layout, layouts: [{ id: "frontier", name: "Frontier", layout }], activeLayoutIndex: 0 });
  const first = { instanceId: "central-bank-rates:1", paneId: "central-bank-rates", binding: { kind: "none" as const } };
  const target = gridDockTarget(grids, config(opened), first.instanceId, size, utilityWindowsOf(opened, utility));
  expect(target).toEqual({ relativeTo: first.instanceId, position: "right" });
  // With a pane docked, an Ask Gloom window floating beside the account one still leaves the next pane docking.
  const askg = { instanceId: "askg:main", paneId: "askg", binding: { kind: "none" as const } };
  const built = addPaneToLayout(opened, first, target!);
  const withWindows = { ...built, instances: [...built.instances, askg], floating: [...built.floating, window(askg.instanceId)] };
  expect(gridDockTarget(grids, config(withWindows), "sovereign-cds:1", size, utilityWindowsOf(withWindows, utility)))
    .toEqual({ relativeTo: first.instanceId, position: "right" });
  // A data pane's window does stop it.
  const news = { instanceId: "news:1", paneId: "news", binding: { kind: "none" as const } };
  const withNews = { ...withWindows, instances: [...withWindows.instances, news], floating: [...withWindows.floating, window(news.instanceId)] };
  expect(gridDockTarget(grids, config(withNews), "quote:1", size, utilityWindowsOf(withNews, utility))).toBeNull();
});
