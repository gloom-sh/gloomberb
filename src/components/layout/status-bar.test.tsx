import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { getDockedPaneIds } from "../../layout/pane-manager";
import { setSharedRegistryForTests } from "../../plugins/registry";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { cloneLayout, createDefaultConfig, createPaneInstance, type LayoutConfig } from "../../types/config";
import type { AppNotificationRequest } from "../../types/plugin";
import { StatusBar } from "./status-bar";
import { TransientLayoutProvider, useTransientLayout } from "./transient-layout";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  setSharedRegistryForTests(undefined);
});

describe("StatusBar", () => {
  function SeedTransientLayout({
    onActivate,
    onDeactivate,
    onExit,
  }: {
    onActivate?: () => void;
    onDeactivate?: () => void;
    onExit?: () => void;
  }) {
    const { setTransientLayout } = useTransientLayout();
    const [active, setActive] = useState(true);
    useEffect(() => {
      setTransientLayout({
        id: "pane-focus",
        label: "Focus",
        shortcutActionId: "pane-fullscreen",
        active,
        onActivate: () => {
          onActivate?.();
          setActive(true);
        },
        onDeactivate: () => {
          onDeactivate?.();
          setActive(false);
        },
        onExit,
      });
      return () => setTransientLayout(null);
    }, [active, onActivate, onDeactivate, onExit, setTransientLayout]);
    return null;
  }

  test("shows a transient focus layout tab without replacing saved layouts", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-transient-layout-test");
    config.layouts = [
      { name: "Default", layout: cloneLayout(config.layout) },
      { name: "Monitor", layout: cloneLayout(config.layout) },
    ];
    const state = {
      ...createInitialState(config),
      statusBarVisible: true,
    };
    const actions: Array<{ type: string; index?: number }> = [];
    let activateCount = 0;
    let deactivateCount = 0;
    let exitCount = 0;
    const handleActivate = () => { activateCount += 1; };
    const handleDeactivate = () => { deactivateCount += 1; };
    const handleExit = () => { exitCount += 1; };

    await tui.render(
      <AppContext value={createStaticAppStore(state, (action) => actions.push(action as { type: string; index?: number }))}>
        <TransientLayoutProvider>
          <SeedTransientLayout
            onActivate={handleActivate}
            onDeactivate={handleDeactivate}
            onExit={handleExit}
          />
          <StatusBar />
        </TransientLayoutProvider>
      </AppContext>,
      { width: 120, height: 1 },
    );

    await tui.setup().renderOnce();
    await tui.setup().renderOnce();

    const frame = tui.frame();
    expect(frame).toContain("^1 Default");
    expect(frame).toContain("^2 Monitor");
    expect(frame).toContain("^⇧F Focus");

    const monitorX = frame.split("\n")[0]?.indexOf("^2 Monitor") ?? -1;
    expect(monitorX).toBeGreaterThanOrEqual(0);

    await tui.setup().mockMouse.click(monitorX + 1, 0);
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();

    expect(deactivateCount).toBe(1);
    expect(exitCount).toBe(0);
    expect(actions).toContainEqual({ type: "SWITCH_LAYOUT", index: 1 });

    const afterSwitchFrame = tui.frame();
    expect(afterSwitchFrame).toContain("^⇧F Focus");

    const focusX = afterSwitchFrame.split("\n")[0]?.indexOf("^⇧F Focus") ?? -1;
    expect(focusX).toBeGreaterThanOrEqual(0);

    await tui.setup().mockMouse.click(focusX + 1, 0);
    await tui.setup().renderOnce();

    expect(activateCount).toBe(1);

    const activeFocusFrame = tui.frame();
    const activeFocusX = activeFocusFrame.split("\n")[0]?.indexOf("^⇧F Focus") ?? -1;
    expect(activeFocusX).toBeGreaterThanOrEqual(0);

    await tui.setup().mockMouse.click(activeFocusX + 1, 0);
    await tui.setup().renderOnce();

    expect(exitCount).toBe(1);
  });

  test("reorders saved layout tabs by dragging them left and right", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-layout-tab-reorder-test");
    config.layouts = [
      { name: "Home", layout: cloneLayout(config.layout) },
      { name: "Research", layout: cloneLayout(config.layout) },
      { name: "News", layout: cloneLayout(config.layout) },
    ];
    const state = {
      ...createInitialState(config),
      statusBarVisible: true,
    };
    const actions: Array<{ type: string; fromIndex?: number; toIndex?: number }> = [];

    await tui.render(
      <AppContext value={createStaticAppStore(state, (action) => actions.push(action as { type: string; fromIndex?: number; toIndex?: number }))}>
        <StatusBar />
      </AppContext>,
      { width: 120, height: 3 },
    );

    await tui.setup().renderOnce();
    const frame = tui.frame();
    const homeX = frame.split("\n")[0]?.indexOf("^1 Home") ?? -1;
    const newsX = frame.split("\n")[0]?.indexOf("^3 News") ?? -1;
    expect(homeX).toBeGreaterThanOrEqual(0);
    expect(newsX).toBeGreaterThan(homeX);

    await act(async () => {
      await tui.setup().mockMouse.drag(homeX + 1, 0, newsX + 1, 0);
      await tui.setup().renderOnce();
    });

    expect(actions).toContainEqual({ type: "REORDER_LAYOUT", fromIndex: 0, toIndex: 2 });
  });

  /** Float three chat windows at `rect(index)`, then click Tidy Windows. */
  async function tidyFloatingWindows(rect: (index: number) => { x: number; y: number; width: number }) {
    const config = createDefaultConfig("/tmp/gloomberb-tidy-test");
    const floatingLayout: LayoutConfig = {
      dockRoot: null,
      instances: Array.from({ length: 3 }, (_, index) => createPaneInstance("chat", { instanceId: `chat-${index}` })),
      floating: Array.from({ length: 3 }, (_, index) => ({
        instanceId: `chat-${index}`,
        ...rect(index),
        height: 20,
        zIndex: 50 + index,
      })),
      detached: [],
    };
    const state = {
      ...createInitialState({
        ...config,
        layout: floatingLayout,
        layouts: [{ name: "Default", layout: cloneLayout(floatingLayout) }],
      }),
      statusBarVisible: true,
    };
    const result = {
      actions: [] as Array<{ type: string }>,
      notifications: [] as AppNotificationRequest[],
      updatedLayout: null as LayoutConfig | null,
    };

    setSharedRegistryForTests({
      panes: new Map([["chat", { name: "Chat" }]]),
      getLayout: () => state.config.layout,
      getTermSize: () => ({ width: 120, height: 40 }),
      updateLayout: (layout: LayoutConfig) => { result.updatedLayout = layout; },
      notify: (notification: AppNotificationRequest) => { result.notifications.push(notification); },
      renderSlot: () => null,
    } as any);

    await tui.render(
      <AppContext value={createStaticAppStore(state, (action) => result.actions.push(action as { type: string }))}>
        <StatusBar />
      </AppContext>,
      { width: 120, height: 1 },
    );

    await tui.setup().renderOnce();
    const tidyX = tui.frame().split("\n")[0]?.indexOf("Tidy Windows") ?? -1;
    expect(tidyX).toBeGreaterThanOrEqual(0);

    await tui.setup().mockMouse.click(tidyX + 1, 0);
    await tui.setup().renderOnce();
    return result;
  }

  test("offers to tidy three floating windows and tiles them on click", async () => {
    const { actions, notifications, updatedLayout } = await tidyFloatingWindows((index) => ({ x: index * 40, y: 0, width: 40 }));

    expect(updatedLayout?.floating).toHaveLength(0);
    expect(notifications[0]).toMatchObject({
      body: "Windows tidied",
      type: "success",
      action: { label: "Revert" },
    });
    notifications[0]!.action!.onClick();
    expect(actions).toContainEqual({ type: "UNDO_LAYOUT" });
  });

  test("tidies covered windows instead of leaving them floating", async () => {
    const { notifications, updatedLayout } = await tidyFloatingWindows(() => ({ x: 10, y: 4, width: 50 }));

    expect(updatedLayout?.floating).toHaveLength(0);
    expect(getDockedPaneIds(updatedLayout!)).toHaveLength(3);
    expect(notifications[0]?.body).toBe("Windows tidied");
  });
});
