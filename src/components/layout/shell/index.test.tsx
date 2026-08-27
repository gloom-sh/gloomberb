import { afterEach, describe, expect, test } from "bun:test";
import { TestDialogProvider, testRender } from "../../../renderers/opentui/test-utils";
import { openTuiUiHost } from "../../../renderers/opentui/ui-host";
import type { ReactNode } from "react";
import { act, useReducer, useState } from "react";
import {
  AppContext,
  appReducer,
  createInitialState,
  resolveTickerForPane,
  usePaneTicker,
} from "../../../state/app/context";
import { cloneLayout, createDefaultConfig, TICKER_RESEARCH_PANE_ID, type LayoutConfig } from "../../../types/config";
import type { PluginRegistry } from "../../../plugins/registry";
import type { PaneProps } from "../../../types/plugin";
import { Textarea } from "../../../ui";
import {
  buildNativeWindowState,
  resolvePaneManagementShortcut,
  resolveAppHeaderHeightCells,
  Shell,
} from "./index";
import { resolvePaneFocusSourceLayout } from "./fullscreen";
import { TransientLayoutProvider, useTransientLayout, type TransientLayoutState } from "../transient-layout";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

function createShellPluginRegistry(options?: {
  portfolioListComponent?: (props: PaneProps) => ReactNode;
  tickerDetailComponent?: (props: PaneProps) => ReactNode;
}): PluginRegistry {
  return {
    panes: new Map([
      ["portfolio-list", {
        id: "portfolio-list",
        name: "Portfolio List",
        component: options?.portfolioListComponent ?? (() => <text>Portfolio Body</text>),
        defaultPosition: "left",
      }],
      [TICKER_RESEARCH_PANE_ID, {
        id: TICKER_RESEARCH_PANE_ID,
        name: "Ticker Research",
        component: options?.tickerDetailComponent ?? (() => <text>Ticker Research Body</text>),
        defaultPosition: "right",
        defaultMode: "floating",
      }],
    ]),
    paneTemplates: new Map(),
    commands: new Map(),
    tickerActions: new Map(),
    brokers: new Map(),
    allPlugins: new Map(),
    getPluginPaneIds: () => [],
    getPluginPaneTemplateIds: () => [],
    hasPaneSettings: (paneId: string) => paneId === "portfolio-list:main",
    openPaneSettingsFn: () => {},
    openCommandBar: () => {},
    showPane: () => {},
    openWindowMode: () => {},
    openWindowModeFn: () => {},
    updateLayoutFn: () => {},
    hidePane: () => {},
  } as unknown as PluginRegistry;
}

async function emitKeypress(event: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; super?: boolean; shift?: boolean; alt?: boolean }) {
  await act(async () => {
    const keyEvent = {
      ctrl: false,
      alt: false,
      meta: false,
      option: false,
      shift: false,
      eventType: "press",
      repeated: false,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...event,
    };
    testSetup!.renderer.keyInput.emit("keypress", keyEvent as any);
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
}

type ShellTestAction = { type: string; [key: string]: any };

function requireLayoutInstance(config: ReturnType<typeof createDefaultConfig>, instanceId: string) {
  const instance = config.layout.instances.find((entry) => entry.instanceId === instanceId);
  if (!instance) throw new Error(`missing default pane ${instanceId}`);
  return instance;
}

function createShellStateWithLayout(
  config: ReturnType<typeof createDefaultConfig>,
  layout: LayoutConfig,
  focusedPaneId: string | null,
) {
  return {
    ...createInitialState({
      ...config,
      layout,
      layouts: [{ name: "Default", layout: cloneLayout(layout) }],
    }),
    focusedPaneId,
  };
}

async function renderShellForWindowModeTest(
  state: ReturnType<typeof createInitialState>,
  options: {
    registry?: PluginRegistry;
    width?: number;
    height?: number;
    dispatch?: (action: ShellTestAction) => void;
  } = {},
) {
  const actions: ShellTestAction[] = [];
  const registry = options.registry ?? createShellPluginRegistry();
  testSetup = await testRender(
    <AppContext value={{ state, dispatch: options.dispatch ?? ((action) => actions.push(action)) }}>
      <TestDialogProvider>
        <Shell pluginRegistry={registry} />
      </TestDialogProvider>
    </AppContext>,
    { width: options.width ?? 80, height: options.height ?? 24 },
  );
  await testSetup.renderOnce();
  return { actions, registry };
}

function CaptureTransientLayout({
  controls,
}: {
  controls: { transientLayout: TransientLayoutState | null };
}) {
  const { transientLayout } = useTransientLayout();
  controls.transientLayout = transientLayout;
  return null;
}

function ShellTransientHarness({
  initialState,
  registry,
  controls,
}: {
  initialState: ReturnType<typeof createInitialState>;
  registry: PluginRegistry;
  controls: {
    dispatch?: (action: ShellTestAction) => void;
    state?: ReturnType<typeof createInitialState>;
    transientLayout: TransientLayoutState | null;
  };
}) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  controls.dispatch = dispatch;
  controls.state = state;
  return (
    <AppContext value={{ state, dispatch }}>
      <TransientLayoutProvider>
        <TestDialogProvider>
          <Shell pluginRegistry={registry} />
        </TestDialogProvider>
        <CaptureTransientLayout controls={controls} />
      </TransientLayoutProvider>
    </AppContext>
  );
}

function findUpdateLayout(actions: ShellTestAction[]) {
  return actions.find((action) => action.type === "UPDATE_LAYOUT");
}

describe("Shell", () => {
  test("uses the desktop titlebar overlay height for shell chrome math", () => {
    expect(resolveAppHeaderHeightCells({ titleBarOverlay: true, cellHeightPx: 18 })).toBe(28 / 18);
    expect(resolveAppHeaderHeightCells({ titleBarOverlay: false, cellHeightPx: 18 })).toBe(1);
  });

  test("keeps command bar native occlusion scoped to the panel", () => {
    const state = buildNativeWindowState(
      ["portfolio-list:main"],
      [],
      null,
      { open: false, width: 120, contentHeight: 40 },
      [
        {
          id: "command-bar:panel",
          rect: { x: 24, y: 8, width: 72, height: 14 },
          zIndex: Number.MAX_SAFE_INTEGER,
        },
      ],
    );

    expect(state.occluders).toEqual([
      {
        id: "command-bar:panel",
        paneId: null,
        rect: { x: 24, y: 9, width: 72, height: 14 },
        zIndex: Number.MAX_SAFE_INTEGER,
      },
    ]);
    expect(state.occluders.some((occluder) => occluder.id === "overlay:global")).toBe(false);
  });

  test("opens the pane menu when clicking the docked header action area", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-test");
    const mainPane = config.layout.instances.find((instance) => instance.instanceId === "portfolio-list:main");
    if (!mainPane) throw new Error("missing default portfolio pane");

    const singlePaneLayout = {
      dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
      instances: [{ ...mainPane }],
      floating: [],
    };
    const nextConfig = {
      ...config,
      layout: cloneLayout(singlePaneLayout),
      layouts: [{ name: "Default", layout: cloneLayout(singlePaneLayout) }],
    };
    const state = createInitialState(nextConfig);
    const pluginRegistry = createShellPluginRegistry();

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <TestDialogProvider>
          <Shell pluginRegistry={pluginRegistry} />
        </TestDialogProvider>
      </AppContext>,
      { width: 40, height: 10 },
    );

    await testSetup.renderOnce();
    const actionCol = testSetup.captureCharFrame().split("\n")[0]?.indexOf("...");
    expect(actionCol).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await testSetup!.mockMouse.click(actionCol! + 1, 1);
    });
    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Settings");
    expect(frame).toContain("Ctrl+,");
    expect(frame).not.toContain("Layout Actions");
    expect(frame).not.toContain("CmdOrCtrl");
  });

  test("shows a Pop Out action in the pane menu when a desktop bridge is available", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-test");
    const mainPane = config.layout.instances.find((instance) => instance.instanceId === "portfolio-list:main");
    if (!mainPane) throw new Error("missing default portfolio pane");

    const singlePaneLayout = {
      dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
      instances: [{ ...mainPane }],
      floating: [],
      detached: [],
    };
    const nextConfig = {
      ...config,
      layout: cloneLayout(singlePaneLayout),
      layouts: [{ name: "Default", layout: cloneLayout(singlePaneLayout) }],
    };
    const state = createInitialState(nextConfig);
    const pluginRegistry = createShellPluginRegistry();

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <TestDialogProvider>
          <Shell
            pluginRegistry={pluginRegistry}
            desktopWindowBridge={{
              kind: "main",
              popOutPane: async () => {},
              subscribeState: () => () => {},
              subscribeDockPreview: () => () => {},
            }}
          />
        </TestDialogProvider>
      </AppContext>,
      { width: 40, height: 10 },
    );

    await testSetup.renderOnce();
    const floatingActionCol = testSetup.captureCharFrame().split("\n")[0]?.indexOf("...");
    expect(floatingActionCol).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await testSetup!.mockMouse.click(floatingActionCol! + 1, 1);
    });
    await testSetup.renderOnce();

    expect(testSetup.captureCharFrame()).toContain("Pop Out");
  });

  test("shows the pane menu above a high z-index floating pane", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-test");
    const detailPane = config.layout.instances.find((instance) => instance.instanceId === "ticker-detail:main");
    if (!detailPane) throw new Error("missing default Ticker Research pane");

    const floatingOnlyLayout = {
      dockRoot: null,
      instances: [{ ...detailPane }],
      floating: [{ instanceId: "ticker-detail:main", x: 0, y: 0, width: 40, height: 8, zIndex: 195 }],
    };
    const nextConfig = {
      ...config,
      layout: cloneLayout(floatingOnlyLayout),
      layouts: [{ name: "Default", layout: cloneLayout(floatingOnlyLayout) }],
    };
    const state = {
      ...createInitialState(nextConfig),
      focusedPaneId: "ticker-detail:main",
    };
    const pluginRegistry = createShellPluginRegistry();

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <TestDialogProvider>
          <Shell pluginRegistry={pluginRegistry} />
        </TestDialogProvider>
      </AppContext>,
      { width: 40, height: 10 },
    );

    await testSetup.renderOnce();
    const highZActionCol = testSetup.captureCharFrame().split("\n")[0]?.indexOf("...");
    expect(highZActionCol).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await testSetup!.mockMouse.click(highZActionCol! + 1, 1);
    });
    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Dock Pane");
    expect(frame).not.toContain("Layout Actions");
  });

  test("resolves pane management shortcuts", () => {
    const base = { ctrl: false, meta: true, super: true, shift: true, alt: false };
    expect(resolvePaneManagementShortcut({ ...base, name: ",", key: ",", shift: false })).toBe("settings");
    expect(resolvePaneManagementShortcut({ ...base, name: "w", key: "w", ctrl: true, meta: false, super: false, shift: false })).toBe("close");
    expect(resolvePaneManagementShortcut({ ...base, name: "w", key: "w", shift: false, alt: true })).toBe("close-all-floating");
    expect(resolvePaneManagementShortcut({ ...base, name: "W", key: "W", shift: false })).toBeNull();
    expect(resolvePaneManagementShortcut({ ...base, name: "D", key: "D" })).toBe("toggle-floating");
    expect(resolvePaneManagementShortcut({ ...base, name: "o", key: "o" })).toBe("pop-out");
    expect(resolvePaneManagementShortcut({ ...base, name: "c", key: "c" })).toBe("copy-screenshot");
    expect(resolvePaneManagementShortcut({ ...base, name: "s", key: "s" })).toBe("share");
    expect(resolvePaneManagementShortcut({ ...base, name: "l", key: "l" })).toBe("layout-gallery");
    expect(resolvePaneManagementShortcut({ ...base, name: "f", key: "f" })).toBe("toggle-fullscreen");
    expect(resolvePaneManagementShortcut({ ...base, name: "g", key: "g" })).toBe("gridlock-all");
    expect(resolvePaneManagementShortcut({ ...base, name: "m", key: "m" })).toBe("window-mode");
    expect(resolvePaneManagementShortcut({ ...base, name: "r", key: "r" })).toBe("window-resize-mode");
    expect(resolvePaneManagementShortcut({ ...base, name: "n", key: "n" })).toBeNull();
    expect(resolvePaneManagementShortcut({ ...base, name: "d", key: "d", alt: true })).toBeNull();
    expect(resolvePaneManagementShortcut({ ...base, name: "d", key: "d", meta: false, super: false })).toBeNull();
  });

  test("opens the layout browser from the primary Shift-L shortcut", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-layout-browser-shortcut-test");
    const opened: string[] = [];
    const registry = createShellPluginRegistry();
    registry.showPane = (paneId) => opened.push(paneId);
    await renderShellForWindowModeTest(createInitialState(config), { registry });

    await emitKeypress({ name: "l", ctrl: true, shift: true });

    expect(opened).toEqual(["layout-marketplace"]);
  });

  test("toggles the focused pane fullscreen without persisting layout", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-fullscreen-shortcut-test");
    const mainPane = requireLayoutInstance(config, "portfolio-list:main");
    const detailPane = requireLayoutInstance(config, "ticker-detail:main");
    const dockedLayout = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        second: { kind: "pane" as const, instanceId: "ticker-detail:main" },
      },
      instances: [{ ...mainPane }, { ...detailPane }],
      floating: [],
      detached: [],
    };
    const { actions } = await renderShellForWindowModeTest(
      createShellStateWithLayout(config, dockedLayout, "portfolio-list:main"),
      { width: 80, height: 18 },
    );

    expect(testSetup.captureCharFrame()).toContain("Main Portfolio");
    expect(testSetup.captureCharFrame()).toContain("Ticker Research Body");

    await emitKeypress({ name: "f", ctrl: true, shift: true });
    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Main Portfolio");
    expect(frame).not.toContain("Ticker Research Body");
    expect(actions.some((action) => action.type === "UPDATE_LAYOUT")).toBe(false);

    await emitKeypress({ name: "f", ctrl: true, shift: true });
    await act(async () => {
      await testSetup!.renderOnce();
    });
    frame = testSetup.captureCharFrame();
    expect(frame).toContain("Main Portfolio");
    expect(frame).toContain("Ticker Research Body");
    expect(actions.some((action) => action.type === "UPDATE_LAYOUT")).toBe(false);
  });

  test("captures the source layout for transient pane focus", () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-fullscreen-layout-test");
    const layout = cloneLayout(config.layout);
    layout.dockRoot = { kind: "pane", instanceId: "portfolio-list:main" };
    layout.floating = [{ instanceId: "ticker-detail:main", x: 8, y: 2, width: 32, height: 10, zIndex: 75 }];

    const focusedLayout = resolvePaneFocusSourceLayout(layout, "ticker-detail:main");

    expect(focusedLayout).toMatchObject({
      dockRoot: { kind: "pane", instanceId: "portfolio-list:main" },
      floating: [{ instanceId: "ticker-detail:main", x: 8, y: 2, width: 32, height: 10, zIndex: 75 }],
    });
    expect(focusedLayout).not.toBe(layout);
    expect(focusedLayout?.instances.map((instance) => instance.instanceId)).toEqual(
      layout.instances.map((instance) => instance.instanceId),
    );
  });

  test("locks layout-changing mouse drags while fullscreen is active", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-fullscreen-drag-test");
    const mainPane = requireLayoutInstance(config, "portfolio-list:main");
    const detailPane = requireLayoutInstance(config, "ticker-detail:main");
    const dockedLayout = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        second: { kind: "pane" as const, instanceId: "ticker-detail:main" },
      },
      instances: [{ ...mainPane }, { ...detailPane }],
      floating: [],
      detached: [],
    };
    const { actions } = await renderShellForWindowModeTest(
      createShellStateWithLayout(config, dockedLayout, "portfolio-list:main"),
      { width: 80, height: 18 },
    );

    await emitKeypress({ name: "f", ctrl: true, shift: true });
    await act(async () => {
      await testSetup!.mockMouse.drag(4, 0, 32, 4);
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Main Portfolio");
    expect(frame).not.toContain("Ticker Research Body");
    expect(actions.some((action) => action.type === "UPDATE_LAYOUT")).toBe(false);
  });

  test("updates the floating pane preview before mouse release", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-live-floating-drag-test");
    const floatingLayout = cloneLayout(config.layout);
    floatingLayout.dockRoot = { kind: "pane", instanceId: "portfolio-list:main" };
    floatingLayout.floating = [{ instanceId: "ticker-detail:main", x: 8, y: 2, width: 32, height: 10, zIndex: 75 }];
    await renderShellForWindowModeTest(
      createShellStateWithLayout(config, floatingLayout, "ticker-detail:main"),
      { width: 80, height: 18 },
    );

    await act(async () => {
      await testSetup!.mockMouse.pressDown(10, 3);
      await testSetup!.renderOnce();
      await testSetup!.mockMouse.moveTo(16, 6);
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup!.captureCharFrame();
    const rows = frame.split("\n");
    expect(rows[2]?.indexOf(":: Main Portfolio") ?? -1).toBeLessThan(0);
    expect(rows[5]?.indexOf(":: Main Portfolio")).toBeGreaterThanOrEqual(14);

    await act(async () => {
      await testSetup!.mockMouse.release(16, 6);
      await testSetup!.renderOnce();
    });
  });

  test("keeps the focused textarea cursor visible when it is not covered", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-cursor-visible-test");
    const mainPane = requireLayoutInstance(config, "portfolio-list:main");
    const detailPane = requireLayoutInstance(config, "ticker-detail:main");
    const registry = createShellPluginRegistry({
      portfolioListComponent: ({ focused, width, height }) => (
        <Textarea
          initialValue=""
          focused={focused}
          width={width}
          height={Math.max(1, height)}
        />
      ),
      tickerDetailComponent: () => <text>Chart Body</text>,
    });
    const layout = {
      dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
      instances: [{ ...mainPane }, { ...detailPane }],
      floating: [{ instanceId: "ticker-detail:main", x: 30, y: 2, width: 24, height: 8, zIndex: 75 }],
      detached: [],
    };
    await renderShellForWindowModeTest(
      createShellStateWithLayout(config, layout, "portfolio-list:main"),
      { registry, width: 80, height: 18 },
    );
    await testSetup!.renderOnce();

    expect(testSetup!.renderer.getCursorState().visible).toBe(true);
  });

  test("hides the textarea cursor when a higher floating pane covers it", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-cursor-occlusion-test");
    const mainPane = requireLayoutInstance(config, "portfolio-list:main");
    const detailPane = requireLayoutInstance(config, "ticker-detail:main");
    const registry = createShellPluginRegistry({
      portfolioListComponent: ({ focused, width, height }) => (
        <Textarea
          initialValue=""
          focused={focused}
          width={width}
          height={Math.max(1, height)}
        />
      ),
      tickerDetailComponent: () => <text>Chart Body</text>,
    });
    const layout = {
      dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
      instances: [{ ...mainPane }, { ...detailPane }],
      floating: [{ instanceId: "ticker-detail:main", x: 0, y: 0, width: 40, height: 8, zIndex: 75 }],
      detached: [],
    };
    await renderShellForWindowModeTest(
      createShellStateWithLayout(config, layout, "portfolio-list:main"),
      { registry, width: 80, height: 18 },
    );
    await testSetup!.renderOnce();

    expect(testSetup!.renderer.getCursorState().visible).toBe(false);
  });

  test("keeps focused pane local detail state when maximizing a floating pane", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-fullscreen-local-state-test");
    const detailPane = requireLayoutInstance(config, "ticker-detail:main");
    let openDetail: (() => void) | null = null;
    const registry = createShellPluginRegistry({
      tickerDetailComponent: () => {
        const [detailOpen, setDetailOpen] = useState(false);
        openDetail = () => setDetailOpen(true);
        return <text>{detailOpen ? "Detail State" : "Table State"}</text>;
      },
    });
    const floatingLayout = {
      dockRoot: null,
      instances: [{ ...detailPane }],
      floating: [{ instanceId: "ticker-detail:main", x: 4, y: 2, width: 40, height: 10, zIndex: 50 }],
      detached: [],
    };
    await renderShellForWindowModeTest(
      createShellStateWithLayout(config, floatingLayout, "ticker-detail:main"),
      { registry, width: 80, height: 18 },
    );

    await act(async () => {
      openDetail?.();
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("etail State");

    await emitKeypress({ name: "f", ctrl: true, shift: true });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("etail State");
    expect(frame).not.toContain("able State");
  });

  test("allows pane fullscreen shortcut while text input is captured on desktop", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-fullscreen-captured-input-test");
    const mainPane = requireLayoutInstance(config, "portfolio-list:main");
    const detailPane = requireLayoutInstance(config, "ticker-detail:main");
    const dockedLayout = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        second: { kind: "pane" as const, instanceId: "ticker-detail:main" },
      },
      instances: [{ ...mainPane }, { ...detailPane }],
      floating: [],
      detached: [],
    };
    const { actions } = await renderShellForWindowModeTest(
      {
        ...createShellStateWithLayout(config, dockedLayout, "portfolio-list:main"),
        inputCaptured: true,
      },
      { width: 80, height: 18 },
    );

    await emitKeypress({
      name: "f",
      key: "f",
      super: true,
      shift: true,
      targetEditable: true,
    } as any);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Main Portfolio");
    expect(frame).not.toContain("Ticker Research Body");
    expect(actions.some((action) => action.type === "UPDATE_LAYOUT")).toBe(false);
  });

  test("keeps the transient focus layout available after switching saved layouts", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-transient-focus-layout-tab-test");
    const mainPane = requireLayoutInstance(config, "portfolio-list:main");
    const detailPane = requireLayoutInstance(config, "ticker-detail:main");
    const defaultLayout = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        second: { kind: "pane" as const, instanceId: "ticker-detail:main" },
      },
      instances: [{ ...mainPane }, { ...detailPane }],
      floating: [],
      detached: [],
    };
    const monitorLayout = {
      dockRoot: { kind: "pane" as const, instanceId: "ticker-detail:main" },
      instances: [{ ...detailPane }],
      floating: [],
      detached: [],
    };
    config.layout = cloneLayout(defaultLayout);
    config.layouts = [
      { name: "Default", layout: cloneLayout(defaultLayout), focusedPaneId: "portfolio-list:main" },
      { name: "Monitor", layout: cloneLayout(monitorLayout), focusedPaneId: "ticker-detail:main" },
    ];
    config.activeLayoutIndex = 0;

    const initialState = {
      ...createInitialState(config),
      focusedPaneId: "portfolio-list:main",
      statusBarVisible: true,
    };
    const registry = createShellPluginRegistry();
    const controls: {
      dispatch?: (action: ShellTestAction) => void;
      state?: ReturnType<typeof createInitialState>;
      transientLayout: TransientLayoutState | null;
    } = { transientLayout: null };

    testSetup = await testRender(
      <ShellTransientHarness initialState={initialState} registry={registry} controls={controls} />,
      { width: 100, height: 18 },
    );

    await testSetup.renderOnce();
    await emitKeypress({ name: "f", ctrl: true, shift: true });

    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Main Portfolio");
    expect(frame).not.toContain("Ticker Research Body");
    expect(controls.transientLayout).toMatchObject({
      id: "pane-focus",
      active: true,
    });

    await act(async () => {
      controls.transientLayout?.onDeactivate?.();
      controls.dispatch?.({ type: "SWITCH_LAYOUT", index: 1 });
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(controls.transientLayout).toMatchObject({
      id: "pane-focus",
      active: false,
    });

    await act(async () => {
      controls.transientLayout?.onActivate?.();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(controls.transientLayout).toMatchObject({
      id: "pane-focus",
      active: true,
    });
  });

  test("restores the focus source layout state when reactivating transient focus", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-transient-focus-state-test");
    const mainPane = requireLayoutInstance(config, "portfolio-list:main");
    const detailPane = requireLayoutInstance(config, "ticker-detail:main");
    const defaultLayout = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        second: { kind: "pane" as const, instanceId: "ticker-detail:main" },
      },
      instances: [{ ...mainPane }, { ...detailPane }],
      floating: [],
      detached: [],
    };
    const monitorLayout = cloneLayout(defaultLayout);
    config.layout = cloneLayout(defaultLayout);
    config.layouts = [
      {
        name: "Default",
        layout: cloneLayout(defaultLayout),
        focusedPaneId: "ticker-detail:main",
        paneState: {
          "portfolio-list:main": { collectionId: "main", cursorSymbol: "MSTR" },
          "ticker-detail:main": { activeTabId: "overview" },
        },
      },
      {
        name: "Monitor",
        layout: monitorLayout,
        focusedPaneId: "ticker-detail:main",
        paneState: {
          "portfolio-list:main": { collectionId: "main", cursorSymbol: null },
          "ticker-detail:main": { activeTabId: "overview" },
        },
      },
    ];
    config.activeLayoutIndex = 0;
    const registry = createShellPluginRegistry({
      tickerDetailComponent: () => {
        const { symbol } = usePaneTicker();
        return <text>{`Ticker:${symbol ?? "none"}`}</text>;
      },
    });
    const controls: {
      dispatch?: (action: ShellTestAction) => void;
      state?: ReturnType<typeof createInitialState>;
      transientLayout: TransientLayoutState | null;
    } = { transientLayout: null };

    testSetup = await testRender(
      <ShellTransientHarness
        initialState={createInitialState(config)}
        registry={registry}
        controls={controls}
      />,
      { width: 100, height: 18 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("icker:MSTR");

    await emitKeypress({ name: "f", ctrl: true, shift: true });
    expect(testSetup.captureCharFrame()).toContain("icker:MSTR");

    await act(async () => {
      controls.transientLayout?.onDeactivate?.();
      controls.dispatch?.({ type: "SWITCH_LAYOUT", index: 1 });
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    expect(controls.transientLayout).toMatchObject({
      id: "pane-focus",
      active: false,
    });
    expect(controls.state?.config.activeLayoutIndex).toBe(1);
    expect(controls.state?.paneState["portfolio-list:main"]?.cursorSymbol).toBeNull();
    expect(controls.state ? resolveTickerForPane(controls.state, "ticker-detail:main") : null).toBeNull();

    await act(async () => {
      controls.transientLayout?.onActivate?.();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(controls.transientLayout).toMatchObject({
      id: "pane-focus",
      active: true,
    });
    expect(controls.state?.config.activeLayoutIndex).toBe(0);
    expect(controls.state?.paneState["portfolio-list:main"]?.cursorSymbol).toBe("MSTR");
    expect(controls.state ? resolveTickerForPane(controls.state, "ticker-detail:main") : null).toBe("MSTR");
  });

  test("exits window mode on Enter without changes", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-window-mode-resize-shortcut-test");
    const mainPane = requireLayoutInstance(config, "portfolio-list:main");
    const detailPane = requireLayoutInstance(config, "ticker-detail:main");
    const dockedLayout = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        second: { kind: "pane" as const, instanceId: "ticker-detail:main" },
      },
      instances: [{ ...mainPane }, { ...detailPane }],
      floating: [],
      detached: [],
    };
    const { actions } = await renderShellForWindowModeTest(
      createShellStateWithLayout(config, dockedLayout, "portfolio-list:main"),
    );

    await emitKeypress({ name: "m", ctrl: true, shift: true });
    expect(testSetup.captureCharFrame()).toContain("WINDOW MOVE");

    await emitKeypress({ name: "enter" });
    await act(async () => {
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).not.toContain("WINDOW MOVE");
    expect(actions.some((action) => action.type === "UPDATE_LAYOUT")).toBe(false);
  });

  test("starts resize mode directly from the resize shortcut", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-window-mode-resize-shortcut-test");
    const mainPane = requireLayoutInstance(config, "portfolio-list:main");
    const detailPane = requireLayoutInstance(config, "ticker-detail:main");
    const dockedLayout = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        second: { kind: "pane" as const, instanceId: "ticker-detail:main" },
      },
      instances: [{ ...mainPane }, { ...detailPane }],
      floating: [],
      detached: [],
    };
    const { actions } = await renderShellForWindowModeTest(
      createShellStateWithLayout(config, dockedLayout, "portfolio-list:main"),
    );

    await emitKeypress({ name: "r", ctrl: true, shift: true });
    expect(testSetup.captureCharFrame()).toContain("WINDOW RESIZE");

    await emitKeypress({ name: "enter" });
    await act(async () => {
      await testSetup!.renderOnce();
    });
    const frame = testSetup.captureCharFrame();
    expect(frame).not.toContain("WINDOW RESIZE");
    expect(actions.some((action) => action.type === "UPDATE_LAYOUT")).toBe(false);
  });

  test("moves a floating pane in window mode and commits once", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-window-mode-test");
    const floatingLayout = cloneLayout(config.layout);
    floatingLayout.dockRoot = { kind: "pane", instanceId: "portfolio-list:main" };
    floatingLayout.floating = [{ instanceId: "ticker-detail:main", x: 8, y: 2, width: 32, height: 10, zIndex: 75 }];
    const { actions } = await renderShellForWindowModeTest(
      createShellStateWithLayout(config, floatingLayout, "ticker-detail:main"),
    );

    await emitKeypress({ name: "m", ctrl: true, shift: true });
    await emitKeypress({ name: "right" });
    await emitKeypress({ name: "right" });
    await emitKeypress({ name: "enter" });
    await act(async () => {
      await testSetup!.renderOnce();
    });

    expect(testSetup.captureCharFrame()).toContain("Committed");
    const updateLayout = findUpdateLayout(actions);
    expect(actions.filter((action) => action.type === "PUSH_LAYOUT_HISTORY")).toHaveLength(1);
    expect(updateLayout?.layout.floating.find((entry: any) => entry.instanceId === "ticker-detail:main")).toEqual(expect.objectContaining({
      x: 12,
      y: 2,
    }));
  });

  test("returns to window selection after commit for editing another window", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-window-mode-repeat-test");
    const floatingLayout = cloneLayout(config.layout);
    floatingLayout.dockRoot = null;
    floatingLayout.floating = [
      { instanceId: "portfolio-list:main", x: 2, y: 1, width: 32, height: 10, zIndex: 50 },
      { instanceId: "ticker-detail:main", x: 8, y: 2, width: 32, height: 10, zIndex: 75 },
    ];
    const { actions } = await renderShellForWindowModeTest(
      createShellStateWithLayout(config, floatingLayout, "ticker-detail:main"),
    );

    await emitKeypress({ name: "m", ctrl: true, shift: true });
    await emitKeypress({ name: "right" });
    await emitKeypress({ name: "enter" });

    expect(testSetup.captureCharFrame()).toContain("WINDOW MOVE");

    await emitKeypress({ name: "tab" });
    await emitKeypress({ name: "right" });
    await emitKeypress({ name: "enter" });

    const updates = actions.filter((action) => action.type === "UPDATE_LAYOUT");
    expect(updates).toHaveLength(2);
    expect(updates[0]?.layout.floating.find((entry: any) => entry.instanceId === "ticker-detail:main")).toEqual(expect.objectContaining({
      x: 10,
      y: 2,
    }));
    expect(updates[1]?.layout.floating.find((entry: any) => entry.instanceId === "ticker-detail:main")).toEqual(expect.objectContaining({
      x: 10,
      y: 2,
    }));
    expect(updates[1]?.layout.floating.find((entry: any) => entry.instanceId === "portfolio-list:main")).toEqual(expect.objectContaining({
      x: 4,
      y: 1,
    }));
    const movedPortfolio = updates[1]?.layout.floating.find((entry: any) => entry.instanceId === "portfolio-list:main");
    const movedTicker = updates[1]?.layout.floating.find((entry: any) => entry.instanceId === "ticker-detail:main");
    expect(movedPortfolio?.zIndex).toBeGreaterThan(movedTicker?.zIndex ?? 0);
  });

  test("cycles windows with Tab while staying in window move mode", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-window-mode-cycle-test");
    const floatingLayout = cloneLayout(config.layout);
    floatingLayout.dockRoot = { kind: "pane", instanceId: "portfolio-list:main" };
    floatingLayout.floating = [{ instanceId: "ticker-detail:main", x: 8, y: 2, width: 32, height: 10, zIndex: 75 }];
    const { actions } = await renderShellForWindowModeTest(
      createShellStateWithLayout(config, floatingLayout, "portfolio-list:main"),
    );

    await emitKeypress({ name: "m", ctrl: true, shift: true });
    await emitKeypress({ name: "tab" });
    await emitKeypress({ name: "right" });
    await emitKeypress({ name: "enter" });

    const updateLayout = findUpdateLayout(actions);
    expect(updateLayout?.layout.floating.find((entry: any) => entry.instanceId === "ticker-detail:main")).toEqual(expect.objectContaining({
      x: 10,
      y: 2,
    }));
  });

  test("toggles the selected window between docked and floating in window move mode", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-window-mode-dock-toggle-test");
    const mainPane = requireLayoutInstance(config, "portfolio-list:main");
    const dockedLayout = {
      dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
      instances: [{ ...mainPane }],
      floating: [],
    };
    const { actions } = await renderShellForWindowModeTest(
      createShellStateWithLayout(config, dockedLayout, "portfolio-list:main"),
    );

    await emitKeypress({ name: "m", ctrl: true, shift: true });
    expect(testSetup.captureCharFrame()).toContain("d dock/float");

    await emitKeypress({ name: "d" });
    await emitKeypress({ name: "enter" });
    await emitKeypress({ name: "d" });
    await emitKeypress({ name: "enter" });

    const updates = actions.filter((action) => action.type === "UPDATE_LAYOUT");
    expect(updates).toHaveLength(2);
    expect(updates[0]?.layout.floating.some((entry: any) => entry.instanceId === "portfolio-list:main")).toBe(true);
    expect(updates[1]?.layout.floating.some((entry: any) => entry.instanceId === "portfolio-list:main")).toBe(false);
    expect(updates[1]?.layout.dockRoot).toEqual({ kind: "pane", instanceId: "portfolio-list:main" });
  });

  test("previews a directional docked window move before committing it", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-window-mode-docked-move-test");
    const mainPane = requireLayoutInstance(config, "portfolio-list:main");
    const detailPane = requireLayoutInstance(config, "ticker-detail:main");
    const dockedLayout = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        second: { kind: "pane" as const, instanceId: "ticker-detail:main" },
      },
      instances: [{ ...mainPane }, { ...detailPane, binding: { kind: "fixed" as const, symbol: "MSFT" } }],
      floating: [],
      detached: [],
    };
    const { actions } = await renderShellForWindowModeTest(
      createShellStateWithLayout(config, dockedLayout, "portfolio-list:main"),
    );

    await emitKeypress({ name: "m", ctrl: true, shift: true });
    await emitKeypress({ name: "right" });
    await testSetup.renderOnce();

    expect(actions.some((action) => action.type === "UPDATE_LAYOUT")).toBe(false);
    expect(testSetup.captureCharFrame()).toContain("-> MSFT right");

    await emitKeypress({ name: "enter" });

    const updateLayout = findUpdateLayout(actions);
    const root = updateLayout?.layout.dockRoot;
    expect(root).toEqual(expect.objectContaining({
      kind: "split",
      axis: "horizontal",
    }));
    expect(root?.first).toEqual({ kind: "pane", instanceId: "ticker-detail:main" });
    expect(root?.second).toEqual({ kind: "pane", instanceId: "portfolio-list:main" });
  });

  test("shows desktop window mode status and selected window title", async () => {
    const previousCapabilities = openTuiUiHost.capabilities;
    openTuiUiHost.capabilities = {
      ...previousCapabilities,
      nativePaneChrome: true,
      titleBarOverlay: false,
      precisePointer: true,
      cellWidthPx: 8,
      cellHeightPx: 18,
    };

    try {
      const config = createDefaultConfig("/tmp/gloomberb-shell-native-window-mode-test");
      const desktopLayout = cloneLayout(config.layout);
      desktopLayout.dockRoot = {
        kind: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: { kind: "pane", instanceId: "portfolio-list:main" },
        second: { kind: "pane", instanceId: "ticker-detail:main" },
      };
      desktopLayout.floating = [];
      const registry = createShellPluginRegistry();
      await renderShellForWindowModeTest(
        createShellStateWithLayout(config, desktopLayout, null),
        { registry, width: 100, height: 26, dispatch: () => {} },
      );

      await act(async () => {
        registry.openWindowModeFn("portfolio-list:main", "move");
        await testSetup!.renderOnce();
        await testSetup!.renderOnce();
      });

      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("WINDOW MOVE");
      expect(frame).toContain("WINDOW MOVE · Main Portfolio");
      expect(frame).toContain("Tab/w window");
    } finally {
      openTuiUiHost.capabilities = previousCapabilities;
    }
  });

  test("closes the focused docked pane with Ctrl+W", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-test");
    const mainPane = config.layout.instances.find((instance) => instance.instanceId === "portfolio-list:main");
    if (!mainPane) throw new Error("missing default portfolio pane");

    const singlePaneLayout = {
      dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
      instances: [{ ...mainPane }],
      floating: [],
    };
    const state = {
      ...createInitialState({
        ...config,
        layout: cloneLayout(singlePaneLayout),
        layouts: [{ name: "Default", layout: cloneLayout(singlePaneLayout) }],
      }),
      focusedPaneId: "portfolio-list:main",
    };
    const actions: Array<any> = [];

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: (action) => actions.push(action) }}>
        <TestDialogProvider>
          <Shell pluginRegistry={createShellPluginRegistry()} />
        </TestDialogProvider>
      </AppContext>,
      { width: 40, height: 10 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressKey("w", { ctrl: true });
      await testSetup!.renderOnce();
    });

    const updateLayout = actions.find((action) => action.type === "UPDATE_LAYOUT");
    expect(actions).toContainEqual({ type: "PUSH_LAYOUT_HISTORY" });
    expect(updateLayout?.layout.instances).toEqual([]);
    expect(updateLayout?.layout.floating).toEqual([]);
    expect(updateLayout?.layout.dockRoot).toBeNull();
  });

  test("closes the focused pane after double Escape", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-test");
    const mainPane = config.layout.instances.find((instance) => instance.instanceId === "portfolio-list:main");
    if (!mainPane) throw new Error("missing default portfolio pane");

    const singlePaneLayout = {
      dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
      instances: [{ ...mainPane }],
      floating: [],
    };
    const state = {
      ...createInitialState({
        ...config,
        layout: cloneLayout(singlePaneLayout),
        layouts: [{ name: "Default", layout: cloneLayout(singlePaneLayout) }],
      }),
      focusedPaneId: "portfolio-list:main",
    };
    const actions: Array<any> = [];

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: (action) => actions.push(action) }}>
        <TestDialogProvider>
          <Shell pluginRegistry={createShellPluginRegistry()} />
        </TestDialogProvider>
      </AppContext>,
      { width: 40, height: 10 },
    );

    await testSetup.renderOnce();
    await emitKeypress({ name: "escape", sequence: "\u001b" });
    expect(actions.some((action) => action.type === "UPDATE_LAYOUT")).toBe(false);

    await emitKeypress({ name: "escape", sequence: "\u001b" });

    const updateLayout = actions.find((action) => action.type === "UPDATE_LAYOUT");
    expect(actions).toContainEqual({ type: "PUSH_LAYOUT_HISTORY" });
    expect(updateLayout?.layout.instances).toEqual([]);
    expect(updateLayout?.layout.floating).toEqual([]);
    expect(updateLayout?.layout.dockRoot).toBeNull();
  });

  test("closes the focused floating pane with Ctrl+W", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-test");
    const mainPane = config.layout.instances.find((instance) => instance.instanceId === "portfolio-list:main");
    const detailPane = config.layout.instances.find((instance) => instance.instanceId === "ticker-detail:main");
    if (!mainPane || !detailPane) throw new Error("missing default panes");

    const mixedLayout = {
      dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
      instances: [{ ...mainPane }, { ...detailPane }],
      floating: [{ instanceId: "ticker-detail:main", x: 4, y: 2, width: 30, height: 8 }],
      detached: [],
    };
    const state = {
      ...createInitialState({
        ...config,
        layout: cloneLayout(mixedLayout),
        layouts: [{ name: "Default", layout: cloneLayout(mixedLayout) }],
      }),
      focusedPaneId: "ticker-detail:main",
      previousFocusedPaneId: "portfolio-list:main",
    };
    const actions: Array<any> = [];

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: (action) => actions.push(action) }}>
        <TestDialogProvider>
          <Shell pluginRegistry={createShellPluginRegistry()} />
        </TestDialogProvider>
      </AppContext>,
      { width: 40, height: 12 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressKey("w", { ctrl: true });
      await testSetup!.renderOnce();
    });

    const updateLayout = actions.find((action) => action.type === "UPDATE_LAYOUT");
    expect(actions).toContainEqual({ type: "PUSH_LAYOUT_HISTORY" });
    expect(updateLayout?.layout.instances.map((instance: { instanceId: string }) => instance.instanceId)).toEqual(["portfolio-list:main"]);
    expect(updateLayout?.layout.floating).toEqual([]);
    expect(updateLayout?.layout.dockRoot).toEqual({ kind: "pane", instanceId: "portfolio-list:main" });
    expect(updateLayout?.focusedPaneId).toBe("portfolio-list:main");
  });

  test("closes the focused floating pane with Cmd+W", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-test");
    const mainPane = config.layout.instances.find((instance) => instance.instanceId === "portfolio-list:main");
    const detailPane = config.layout.instances.find((instance) => instance.instanceId === "ticker-detail:main");
    if (!mainPane || !detailPane) throw new Error("missing default panes");

    const mixedLayout = {
      dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
      instances: [{ ...mainPane }, { ...detailPane }],
      floating: [{ instanceId: "ticker-detail:main", x: 4, y: 2, width: 30, height: 8 }],
      detached: [],
    };
    const state = {
      ...createInitialState({
        ...config,
        layout: cloneLayout(mixedLayout),
        layouts: [{ name: "Default", layout: cloneLayout(mixedLayout) }],
      }),
      focusedPaneId: "ticker-detail:main",
    };
    const actions: Array<any> = [];

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: (action) => actions.push(action) }}>
        <TestDialogProvider>
          <Shell pluginRegistry={createShellPluginRegistry()} />
        </TestDialogProvider>
      </AppContext>,
      { width: 40, height: 12 },
    );

    await testSetup.renderOnce();
    await emitKeypress({ name: "w", super: true });

    const updateLayout = actions.find((action) => action.type === "UPDATE_LAYOUT");
    expect(updateLayout?.layout.instances.map((instance: { instanceId: string }) => instance.instanceId)).toEqual(["portfolio-list:main"]);
    expect(updateLayout?.layout.floating).toEqual([]);
  });

  test("closes all floating panes with Ctrl+Alt+W", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-shell-test");
    const mainPane = config.layout.instances.find((instance) => instance.instanceId === "portfolio-list:main");
    const firstDetailPane = config.layout.instances.find((instance) => instance.instanceId === "ticker-detail:main");
    if (!mainPane || !firstDetailPane) throw new Error("missing default panes");
    const secondDetailPane = {
      ...firstDetailPane,
      instanceId: "ticker-detail:secondary",
    };

    const mixedLayout = {
      dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
      instances: [{ ...mainPane }, { ...firstDetailPane }, secondDetailPane],
      floating: [
        { instanceId: "ticker-detail:main", x: 4, y: 2, width: 30, height: 8 },
        { instanceId: "ticker-detail:secondary", x: 8, y: 3, width: 30, height: 8 },
      ],
      detached: [],
    };
    const state = {
      ...createInitialState({
        ...config,
        layout: cloneLayout(mixedLayout),
        layouts: [{ name: "Default", layout: cloneLayout(mixedLayout) }],
      }),
      focusedPaneId: "portfolio-list:main",
    };
    const actions: Array<any> = [];

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: (action) => actions.push(action) }}>
        <TestDialogProvider>
          <Shell pluginRegistry={createShellPluginRegistry()} />
        </TestDialogProvider>
      </AppContext>,
      { width: 40, height: 12 },
    );

    await testSetup.renderOnce();
    await emitKeypress({ name: "w", ctrl: true, alt: true });

    const updateLayout = actions.find((action) => action.type === "UPDATE_LAYOUT");
    expect(actions).toContainEqual({ type: "PUSH_LAYOUT_HISTORY" });
    expect(updateLayout?.layout.instances.map((instance: { instanceId: string }) => instance.instanceId)).toEqual(["portfolio-list:main"]);
    expect(updateLayout?.layout.floating).toEqual([]);
    expect(updateLayout?.layout.dockRoot).toEqual({ kind: "pane", instanceId: "portfolio-list:main" });
  });

});
