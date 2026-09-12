import { describe, expect, test } from "bun:test";
import { createDefaultConfig, type AppConfig } from "../types/config";
import type { AppSessionSnapshot, PaneDef } from "../types/plugin";
import { openPaneForLaunch, seedPaneLaunchSession } from "./launch-layout";

const PANE_ID = "launch-test-pane";

const PANE_DEF: PaneDef = {
  id: PANE_ID,
  name: "Launch test",
  component: () => null,
  defaultPosition: "left",
  defaultMode: "floating",
  defaultFloatingSize: { width: 120, height: 32 },
};

function launch(config: AppConfig, params?: Record<string, string>) {
  return openPaneForLaunch(config, {
    paneId: PANE_ID,
    instanceId: `${PANE_ID}:main`,
    paneDef: PANE_DEF,
    params,
    terminalSize: { width: 140, height: 42 },
  });
}

describe("openPaneForLaunch", () => {
  test("adds the pane as a floating instance and syncs the active workspace", () => {
    const result = launch(createDefaultConfig("/tmp/gloomberb-launch-layout"), { query: "iran" });

    expect(result.paneInstanceId).toBe(`${PANE_ID}:main`);
    expect(result.config.layout.instances.find((instance) => instance.instanceId === result.paneInstanceId)?.params)
      .toEqual({ query: "iran" });
    expect(result.config.layout.floating.some((entry) => entry.instanceId === result.paneInstanceId)).toBe(true);
    // The saved workspace and the live layout are the same layout; writing only
    // one of them loses the pane on the next workspace switch.
    expect(result.config.layouts[result.config.activeLayoutIndex]?.layout.floating
      .some((entry) => entry.instanceId === result.paneInstanceId)).toBe(true);
  });

  test("reuses the instance the user already has rather than adding a second one", () => {
    const first = launch(createDefaultConfig("/tmp/gloomberb-launch-layout"), { query: "iran" });
    const second = launch(first.config, { query: "fed" });

    expect(second.paneInstanceId).toBe(first.paneInstanceId);
    expect(second.config.layout.instances.filter((instance) => instance.paneId === PANE_ID)).toHaveLength(1);
    expect(second.config.layout.instances.find((instance) => instance.instanceId === second.paneInstanceId)?.params)
      .toEqual({ query: "fed" });
  });

  test("re-places an instance that is remembered but no longer in the layout", () => {
    const opened = launch(createDefaultConfig("/tmp/gloomberb-launch-layout"));
    // Closing a pane keeps its instance so its settings survive; the launch has
    // to put it back rather than find it and do nothing.
    const closed: AppConfig = {
      ...opened.config,
      layout: { ...opened.config.layout, floating: [] },
    };

    const relaunched = launch(closed);

    expect(relaunched.paneInstanceId).toBe(opened.paneInstanceId);
    expect(relaunched.config.layout.floating.some((entry) => entry.instanceId === opened.paneInstanceId)).toBe(true);
  });

  test("brings an open floating pane to the front", () => {
    const opened = launch(createDefaultConfig("/tmp/gloomberb-launch-layout"));
    const behind: AppConfig = {
      ...opened.config,
      layout: {
        ...opened.config.layout,
        floating: [
          ...opened.config.layout.floating,
          { ...opened.config.layout.floating[0]!, instanceId: "other:main" },
        ],
      },
    };

    const relaunched = launch(behind);

    expect(relaunched.config.layout.floating.at(-1)?.instanceId).toBe(opened.paneInstanceId);
  });
});

describe("seedPaneLaunchSession", () => {
  test("focuses the pane and merges plugin state over what the last session saved", () => {
    const opened = launch(createDefaultConfig("/tmp/gloomberb-launch-layout"));
    const snapshot: AppSessionSnapshot = {
      paneState: {
        [opened.paneInstanceId]: {
          pluginState: { "launch-test": { query: "old", scrollTop: 40 } },
        },
      },
      focusedPaneId: "portfolio-list:main",
      activePanel: "right",
      statusBarVisible: false,
      openPaneIds: ["portfolio-list:main"],
      hydrationTargets: [],
      exchangeCurrencies: [],
      savedAt: 1,
    };

    const seeded = seedPaneLaunchSession(opened.config, snapshot, {
      paneInstanceId: opened.paneInstanceId,
      pluginId: "launch-test",
      pluginState: { query: "iran", selectedRowKey: null },
    });

    expect(seeded.focusedPaneId).toBe(opened.paneInstanceId);
    expect(seeded.openPaneIds).toContain(opened.paneInstanceId);
    expect(seeded.openPaneIds).toContain("portfolio-list:main");
    expect(seeded.activePanel).toBe("right");
    expect(seeded.statusBarVisible).toBe(false);
    expect((seeded.paneState[opened.paneInstanceId]?.pluginState as Record<string, Record<string, unknown>>)["launch-test"])
      .toEqual({ query: "iran", scrollTop: 40, selectedRowKey: null });
  });

  test("starts from the current layout when there is no previous session", () => {
    const opened = launch(createDefaultConfig("/tmp/gloomberb-launch-layout"));

    const seeded = seedPaneLaunchSession(opened.config, null, {
      paneInstanceId: opened.paneInstanceId,
      pluginId: "launch-test",
      pluginState: { query: "iran" },
    });

    expect(seeded.openPaneIds).toContain(opened.paneInstanceId);
    expect(seeded.activePanel).toBe("left");
    expect(seeded.statusBarVisible).toBe(true);
  });
});
