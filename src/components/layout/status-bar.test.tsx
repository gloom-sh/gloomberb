import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { cloneLayout, createDefaultConfig, TICKER_RESEARCH_PANE_ID, type LayoutConfig } from "../../types/config";
import type { AppNotificationRequest } from "../../types/plugin";
import { StatusBar } from "./status-bar";
import { setSharedRegistryForTests } from "../../plugins/registry";
import { useEffect, useState } from "react";
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

  test("opens the discoverable layout preset menu", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-layout-menu-test");
    config.layouts = [{ name: "Home", layout: cloneLayout(config.layout) }];
    const state = { ...createInitialState(config), statusBarVisible: true };
    const actions: Array<{ type: string; open?: boolean; query?: string }> = [];

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: (action) => actions.push(action as { type: string; open?: boolean; query?: string }) }}>
        <StatusBar />
      </AppContext>,
      { width: 120, height: 1 },
    );
    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    const layoutsX = frame.split("\n")[0]?.indexOf("Layouts") ?? -1;
    expect(layoutsX).toBeGreaterThanOrEqual(0);
    await testSetup.mockMouse.click(layoutsX + 1, 0);
    await testSetup.renderOnce();

    expect(actions).toContainEqual({ type: "SET_COMMAND_BAR", open: true, query: "LAY " });
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

  test("shows a gridlock tip after a corner snap and runs gridlock on click", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const floatingLayout = cloneLayout(config.layout);
    floatingLayout.dockRoot = { kind: "pane", instanceId: "portfolio-list:main" };
    floatingLayout.floating = [{ instanceId: "ticker-detail:main", x: 8, y: 2, width: 36, height: 12 }];

    const state = {
      ...createInitialState({
        ...config,
        layout: floatingLayout,
        layouts: [
          { name: "Default", layout: cloneLayout(floatingLayout) },
          { name: "Research", layout: cloneLayout(floatingLayout) },
        ],
      }),
      statusBarVisible: true,
      gridlockTipVisible: true,
    };

    const actions: Array<{ type: string }> = [];
    let updatedLayout = null as ReturnType<typeof cloneLayout> | null;
    const notifications: AppNotificationRequest[] = [];

    setSharedRegistryForTests({
      panes: new Map([
        ["portfolio-list", {}],
        [TICKER_RESEARCH_PANE_ID, {}],
      ]),
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
    expect(frame).toContain("Snapped a window?");
    expect(frame).toContain("Gridlock All");

    const buttonX = frame.split("\n")[0]?.indexOf("Gridlock All") ?? -1;
    expect(buttonX).toBeGreaterThanOrEqual(0);

    await testSetup.mockMouse.click(buttonX + 1, 0);
    await testSetup.renderOnce();

    expect(updatedLayout?.floating).toHaveLength(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      body: "Retiled all panes",
      type: "success",
      action: { label: "Revert" },
    });
    expect(actions).toContainEqual({ type: "DISMISS_GRIDLOCK_TIP" });

    notifications[0]!.action!.onClick();
    expect(actions).toContainEqual({ type: "UNDO_LAYOUT" });
  });

  test("auto-dismisses the gridlock tip after its timeout", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const state = {
      ...createInitialState(config),
      statusBarVisible: true,
      gridlockTipVisible: true,
      gridlockTipSequence: 1,
    };
    const actions: Array<{ type: string }> = [];
    const timers: Array<{ callback: (() => void) | null; delay: number | undefined }> = [];
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
      timers.push({ callback: typeof callback === "function" ? callback : null, delay });
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

    setSharedRegistryForTests({
      panes: new Map(),
      getLayoutFn: () => state.config.layout,
      getTermSizeFn: () => ({ width: 120, height: 40 }),
      updateLayoutFn: () => {},
      notify: () => {},
      Slot: () => null,
    } as any);

    try {
      testSetup = await testRender(
        <AppContext value={{ state, dispatch: (action) => actions.push(action as { type: string }) }}>
          <StatusBar />
        </AppContext>,
        { width: 120, height: 1 },
      );

      await testSetup.renderOnce();

      const gridlockTimer = timers.find((entry) => entry.delay === 60_000);
      expect(gridlockTimer?.callback).toBeDefined();
      gridlockTimer?.callback?.();

      expect(actions).toContainEqual({ type: "DISMISS_GRIDLOCK_TIP" });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
