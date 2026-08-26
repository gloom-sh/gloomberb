import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { cloneLayout, createDefaultConfig, createPaneInstance, type LayoutConfig } from "../../types/config";
import type { AppNotificationRequest } from "../../types/plugin";
import { StatusBar } from "./status-bar";
import { setSharedRegistryForTests } from "../../plugins/registry";
import { act, useEffect, useState } from "react";
import { TransientLayoutProvider, useTransientLayout } from "./transient-layout";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
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
        label: "^F Focus",
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

  test("opens the command bar from the shortcut hint", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    config.layouts = [{ name: "Home", layout: cloneLayout(config.layout) }];
    const state = {
      ...createInitialState(config),
      statusBarVisible: true,
    };
    const actions: Array<{ type: string; open?: boolean; query?: string }> = [];

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: (action) => actions.push(action as { type: string; open?: boolean; query?: string }) }}>
        <StatusBar />
      </AppContext>,
      { width: 120, height: 1 },
    );

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    const hintX = frame.split("\n")[0]?.indexOf("Ctrl+P") ?? -1;
    expect(hintX).toBeGreaterThanOrEqual(0);

    await testSetup.mockMouse.click(hintX + 1, 0);
    await testSetup.renderOnce();

    expect(actions).toContainEqual({ type: "SET_COMMAND_BAR", open: true, query: "" });
  });

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

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: (action) => actions.push(action as { type: string; index?: number }) }}>
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

    await testSetup.renderOnce();
    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("^1 Default");
    expect(frame).toContain("^2 Monitor");
    expect(frame).toContain("^F Focus");

    const monitorX = frame.split("\n")[0]?.indexOf("^2 Monitor") ?? -1;
    expect(monitorX).toBeGreaterThanOrEqual(0);

    await testSetup.mockMouse.click(monitorX + 1, 0);
    await testSetup.renderOnce();
    await testSetup.renderOnce();

    expect(deactivateCount).toBe(1);
    expect(exitCount).toBe(0);
    expect(actions).toContainEqual({ type: "SWITCH_LAYOUT", index: 1 });

    const afterSwitchFrame = testSetup.captureCharFrame();
    expect(afterSwitchFrame).toContain("^F Focus");

    const focusX = afterSwitchFrame.split("\n")[0]?.indexOf("^F Focus") ?? -1;
    expect(focusX).toBeGreaterThanOrEqual(0);

    await testSetup.mockMouse.click(focusX + 1, 0);
    await testSetup.renderOnce();

    expect(activateCount).toBe(1);

    const activeFocusFrame = testSetup.captureCharFrame();
    const activeFocusX = activeFocusFrame.split("\n")[0]?.indexOf("^F Focus") ?? -1;
    expect(activeFocusX).toBeGreaterThanOrEqual(0);

    await testSetup.mockMouse.click(activeFocusX + 1, 0);
    await testSetup.renderOnce();

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

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: (action) => actions.push(action as { type: string; fromIndex?: number; toIndex?: number }) }}>
        <StatusBar />
      </AppContext>,
      { width: 120, height: 3 },
    );

    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    const homeX = frame.split("\n")[0]?.indexOf("^1 Home") ?? -1;
    const newsX = frame.split("\n")[0]?.indexOf("^3 News") ?? -1;
    expect(homeX).toBeGreaterThanOrEqual(0);
    expect(newsX).toBeGreaterThan(homeX);

    await act(async () => {
      await testSetup!.mockMouse.drag(homeX + 1, 0, newsX + 1, 0);
      await testSetup!.renderOnce();
    });

    expect(actions).toContainEqual({ type: "REORDER_LAYOUT", fromIndex: 0, toIndex: 2 });
  });

  test("offers to tidy three floating windows and tiles them on click", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-tidy-test");
    const floatingLayout: LayoutConfig = {
      dockRoot: null,
      instances: Array.from({ length: 3 }, (_, index) => createPaneInstance("chat", { instanceId: `chat-${index}` })),
      floating: Array.from({ length: 3 }, (_, index) => ({
        instanceId: `chat-${index}`,
        x: index * 40,
        y: 0,
        width: 40,
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
    const actions: Array<{ type: string }> = [];
    let updatedLayout: LayoutConfig | null = null;
    const notifications: AppNotificationRequest[] = [];

    setSharedRegistryForTests({
      panes: new Map([["chat", { name: "Chat" }]]),
      getLayoutFn: () => state.config.layout,
      getTermSizeFn: () => ({ width: 120, height: 40 }),
      updateLayoutFn: (layout: LayoutConfig) => { updatedLayout = layout; },
      notify: (notification: AppNotificationRequest) => { notifications.push(notification); },
      Slot: () => null,
    } as any);

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: (action) => actions.push(action as { type: string }) }}>
        <StatusBar />
      </AppContext>,
      { width: 120, height: 1 },
    );

    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    const buttonX = frame.split("\n")[0]?.indexOf("Tidy Windows") ?? -1;
    expect(buttonX).toBeGreaterThanOrEqual(0);

    await testSetup.mockMouse.click(buttonX + 1, 0);
    await testSetup.renderOnce();

    expect(updatedLayout?.floating).toHaveLength(0);
    expect(notifications[0]).toMatchObject({
      body: "Tiled all windows",
      type: "success",
      action: { label: "Revert" },
    });
    notifications[0]!.action!.onClick();
    expect(actions).toContainEqual({ type: "UNDO_LAYOUT" });
  });

  test("lets users tidy the visible layer without pulling in covered windows", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-covered-test");
    const floatingLayout: LayoutConfig = {
      dockRoot: null,
      instances: Array.from({ length: 3 }, (_, index) => createPaneInstance("chat", { instanceId: `chat-${index}` })),
      floating: Array.from({ length: 3 }, (_, index) => ({
        instanceId: `chat-${index}`,
        x: 10,
        y: 4,
        width: 50,
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
    let updatedLayout: LayoutConfig | null = null;
    const notifications: AppNotificationRequest[] = [];

    setSharedRegistryForTests({
      panes: new Map([["chat", { name: "Chat" }]]),
      getLayoutFn: () => state.config.layout,
      getTermSizeFn: () => ({ width: 120, height: 40 }),
      updateLayoutFn: (layout: LayoutConfig) => { updatedLayout = layout; },
      notify: (notification: AppNotificationRequest) => { notifications.push(notification); },
      Slot: () => null,
    } as any);

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <StatusBar />
      </AppContext>,
      { width: 120, height: 18 },
    );

    await testSetup.renderOnce();
    let frame = testSetup.captureCharFrame();
    const tidyX = frame.split("\n")[0]?.indexOf("Tidy Windows") ?? -1;
    await act(async () => {
      await testSetup!.mockMouse.click(tidyX + 1, 0);
      await Promise.resolve();
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).toContain("1 visible, 2 covered. Choose up to 6 more.");
    expect(frame).toContain("Tidy 1 Selected");
    expect(frame).toContain("Tile All 3");

    const lines = frame.split("\n");
    const buttonY = lines.findIndex((line) => line.includes("Tidy 1 Selected"));
    const buttonX = lines[buttonY]?.indexOf("Tidy 1 Selected") ?? -1;
    await act(async () => {
      await testSetup!.mockMouse.click(buttonX + 1, buttonY);
      await Promise.resolve();
      await testSetup!.renderOnce();
    });

    expect(updatedLayout?.floating).toHaveLength(2);
    expect(notifications[0]?.body).toBe("Tiled 1 window; 2 left floating");
  });
});
