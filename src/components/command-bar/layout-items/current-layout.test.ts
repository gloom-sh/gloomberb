import { describe, expect, test } from "bun:test";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { cloneLayout, createDefaultConfig, type LayoutConfig, type SavedLayout } from "../../../types/config";
import type { PluginRegistry } from "../../../plugins/registry";
import type { CommandBarRoute } from "../workflow/types";
import type { LayoutItemsContext } from "./types";
import { buildCurrentLayoutItems } from "./current-layout";

type InlineConfirmOptions = Parameters<LayoutItemsContext["openInlineConfirm"]>[0];

function createFloatingLayoutFixture(): { layout: LayoutConfig; state: AppState } {
  const config = createDefaultConfig("/tmp/gloomberb-layout-actions-test");
  const mainPane = config.layout.instances.find((instance) => instance.instanceId === "portfolio-list:main");
  const firstDetailPane = config.layout.instances.find((instance) => instance.instanceId === "ticker-detail:main");
  if (!mainPane || !firstDetailPane) throw new Error("missing default panes");

  const secondDetailPane = {
    ...firstDetailPane,
    instanceId: "ticker-detail:secondary",
  };
  const layout: LayoutConfig = {
    dockRoot: { kind: "pane", instanceId: "portfolio-list:main" },
    instances: [{ ...mainPane }, { ...firstDetailPane }, secondDetailPane],
    floating: [
      { instanceId: "ticker-detail:main", x: 4, y: 2, width: 30, height: 8 },
      { instanceId: "ticker-detail:secondary", x: 8, y: 3, width: 30, height: 8 },
    ],
    detached: [],
  };
  const state = createInitialState({
    ...config,
    layout: cloneLayout(layout),
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  });
  return { layout, state };
}

function createLayoutItemsContext(
  options: {
    confirmDangerousActions?: boolean;
    layouts: LayoutConfig[];
    confirmations: InlineConfirmOptions[];
  },
): LayoutItemsContext {
  const { layout, state } = createFloatingLayoutFixture();
  return {
    closeAll: () => {},
    currentLayout: layout,
    dispatch: (_action: AppAction) => {},
    duplicatePane: () => {},
    focusedPaneId: state.focusedPaneId,
    notifyGridlockRevert: () => {},
    openBuiltInWorkflow: () => {},
    openInlineConfirm: (confirmOptions) => {
      options.confirmations.push(confirmOptions);
    },
    persistLayoutChange: (nextLayout) => {
      options.layouts.push(nextLayout);
    },
    pluginRegistry: {
      getTermSizeFn: () => ({ width: 80, height: 24 }),
    } as PluginRegistry,
    pushRoute: (_route: CommandBarRoute) => {},
    state,
    ...(options.confirmDangerousActions === undefined ? {} : { confirmDangerousActions: options.confirmDangerousActions }),
  };
}

describe("buildCurrentLayoutItems", () => {
  test("closes all floating panes from the current layout", () => {
    const layouts: LayoutConfig[] = [];
    const confirmations: InlineConfirmOptions[] = [];
    const items = buildCurrentLayoutItems(createLayoutItemsContext({ layouts, confirmations }));

    const item = items.find((entry) => entry.id === "layout-close-all-floating");
    expect(item).toMatchObject({
      label: "Close All Floating Panes",
      disabled: false,
    });

    item?.action();

    expect(confirmations).toEqual([]);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]?.floating).toEqual([]);
    expect(layouts[0]?.instances.map((instance) => instance.instanceId)).toEqual(["portfolio-list:main"]);
    expect(layouts[0]?.dockRoot).toEqual({ kind: "pane", instanceId: "portfolio-list:main" });
  });

  test("confirms before closing all floating panes when dangerous actions are guarded", () => {
    const layouts: LayoutConfig[] = [];
    const confirmations: InlineConfirmOptions[] = [];
    const items = buildCurrentLayoutItems(createLayoutItemsContext({
      confirmDangerousActions: true,
      layouts,
      confirmations,
    }));

    items.find((entry) => entry.id === "layout-close-all-floating")?.action();

    expect(layouts).toEqual([]);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      confirmId: "layout-close-all-floating",
      title: "Close All Floating Panes",
      confirmLabel: "Close Floating Panes",
      tone: "danger",
    });

    confirmations[0]?.onConfirm();

    expect(layouts).toHaveLength(1);
    expect(layouts[0]?.floating).toEqual([]);
  });
});

describe("moving the layout tab", () => {
  // The status bar draws personal tabs together and each team's after them,
  // so "left" and "right" mean the neighbour in the same group, not in the
  // saved order.
  function moveFrom(activeLayoutIndex: number, itemId: "layout-move-left" | "layout-move-right") {
    const config = createDefaultConfig("/tmp/gloomberb-layout-move-test");
    const saved = (name: string, teamId?: string): SavedLayout => ({
      name,
      layout: cloneLayout(config.layout),
      ...(teamId
        ? { origin: { kind: "team" as const, teamId, layoutId: name, revision: 1, contentHash: "", syncedAt: "" } }
        : {}),
    });
    const state = createInitialState({
      ...config,
      layouts: [saved("A"), saved("Team", "team-1"), saved("B"), saved("C")],
      activeLayoutIndex,
    });
    const actions: AppAction[] = [];
    const context: LayoutItemsContext = {
      ...createLayoutItemsContext({ layouts: [], confirmations: [] }),
      currentLayout: state.config.layout,
      dispatch: (action) => { actions.push(action); },
      state,
    };
    const item = buildCurrentLayoutItems(context).find((entry) => entry.id === itemId)!;
    item.action();
    const next = actions.reduce(appReducer, state);
    return { item, names: next.config.layouts.map((layout) => layout.name), active: next.config.activeLayoutIndex };
  }

  test("trades places with the neighbouring tab of the same group", () => {
    const left = moveFrom(2, "layout-move-left");
    expect(left.item).toMatchObject({ disabled: false, right: "2/3" });
    expect(left.names).toEqual(["B", "A", "Team", "C"]);
    expect(left.active).toBe(0);

    const right = moveFrom(2, "layout-move-right");
    expect(right.names).toEqual(["A", "Team", "C", "B"]);
    expect(right.active).toBe(3);
  });

  test("stops at the ends of the group", () => {
    const first = moveFrom(0, "layout-move-left");
    expect(first.item.disabled).toBe(true);
    expect(first.names).toEqual(["A", "Team", "B", "C"]);
    expect(moveFrom(1, "layout-move-right").item.disabled).toBe(true);
  });
});
