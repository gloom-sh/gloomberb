import { afterEach, describe, expect, test } from "bun:test";
import { act, useRef, useState, type Dispatch } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, AppProvider, PaneInstanceProvider, createInitialState, useAppDispatch, useAppSelector, usePaneSettingValue, usePaneStateValue, usePaneTicker, usePaneTitle, type AppAction } from "./index";
import { cloneLayout, createDefaultConfig, type AppConfig } from "../../../types/config";
import { applyTheme } from "../../../theme/colors";
import { useThemeId } from "../../../theme/theme-context";
import { DEFAULT_THEME } from "../../../theme/themes";
import type { DesktopSharedStateSnapshot, DesktopThemePreviewState, DesktopWindowBridge } from "../../../types/desktop-window";

const TEST_PANE_ID = "ticker-detail:test";

let capturedDispatch: Dispatch<AppAction> | null = null;
let capturedPaneSetting: ((value: string) => void) | null = null;

function createTickerDetailConfig(symbol: string): AppConfig {
  const config = createDefaultConfig("/tmp/gloomberb-test");
  const layout = {
    dockRoot: { kind: "pane" as const, instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: "ticker-detail",
      binding: { kind: "fixed" as const, symbol },
    }],
    floating: [],
    detached: [],
  };

  return {
    ...config,
    layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  };
}

function DispatchCapture() {
  capturedDispatch = useAppDispatch();
  return null;
}

function PaneTickerHarness() {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const { symbol } = usePaneTicker();
  return <text>{`${symbol ?? "none"}:${renderCountRef.current}`}</text>;
}

function PaneSettingHarness() {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const [value, setValue] = usePaneSettingValue("mode", "table");
  capturedPaneSetting = setValue;
  return <text>{`${value}:${renderCountRef.current}`}</text>;
}

function ThemeSelectorHarness() {
  const focusedPaneId = useAppSelector((state) => state.focusedPaneId);
  const themeId = useThemeId();
  return <text>{`${focusedPaneId ?? "none"}:${themeId}`}</text>;
}

function ActiveLayoutHarness() {
  const activeLayoutIndex = useAppSelector((state) => state.config.activeLayoutIndex);
  return <text>{`layout:${activeLayoutIndex}`}</text>;
}

function createDesktopBridge(
  kind: "main" | "detached",
  calls: {
    mainSnapshots?: DesktopSharedStateSnapshot[];
    themePreviews?: DesktopThemePreviewState[];
    onStateSubscribe?: (listener: (snapshot: DesktopSharedStateSnapshot) => void) => void;
    onThemePreviewSubscribe?: (listener: (preview: DesktopThemePreviewState) => void) => void;
  } = {},
): DesktopWindowBridge {
  return {
    kind,
    paneId: kind === "detached" ? TEST_PANE_ID : undefined,
    syncMainState: kind === "main"
      ? async (snapshot) => {
        calls.mainSnapshots?.push(snapshot);
      }
      : undefined,
    syncThemePreview: kind === "main"
      ? async (preview) => {
        calls.themePreviews?.push(preview);
      }
      : undefined,
    subscribeState: (listener) => {
      calls.onStateSubscribe?.(listener);
      return () => {};
    },
    subscribeThemePreview: kind === "detached"
      ? (listener) => {
        calls.onThemePreviewSubscribe?.(listener);
        return () => {};
      }
      : undefined,
  };
}

describe("pane selectors", () => {
  const tui = createOpenTuiTestHarness();

  afterEach(() => {
    capturedDispatch = null;
    capturedPaneSetting = null;
    applyTheme(DEFAULT_THEME);
  });

  test("pane settings and derived titles preserve the saved layout when pane scoping changes", async () => {
    let useContextId: () => void = () => {};
    let changeChannel: (value: string) => void = () => {};
    let currentConfig = createTickerDetailConfig("AAPL");
    function PaneModel() {
      const [explicit, setExplicit] = useState(true);
      useContextId = () => setExplicit(false);
      const id = explicit ? TEST_PANE_ID : undefined;
      const [channel, setChannel] = usePaneSettingValue("channel", "one", id);
      const [position] = usePaneStateValue("position", 0, id);
      changeChannel = setChannel;
      usePaneTitle(`Feed: ${channel}`, id);
      currentConfig = useAppSelector((state) => state.config);
      return <text>{`${channel}:${position}`}</text>;
    }
    await tui.render(
      <AppProvider config={currentConfig}>
        <PaneInstanceProvider paneId={TEST_PANE_ID}><PaneModel /></PaneInstanceProvider>
      </AppProvider>,
      { width: 24, height: 4 },
    );
    await tui.setup().renderOnce();
    await act(useContextId);
    await tui.setup().renderOnce();
    await act(() => changeChannel("two"));
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
    const pane = currentConfig.layout.instances[0]!;
    expect(pane).toMatchObject({
      instanceId: TEST_PANE_ID, title: "Feed: two", settings: { channel: "two" },
      binding: { kind: "fixed", symbol: "AAPL" },
    });
    expect(currentConfig.layouts[0]!.layout.instances[0]).toEqual(pane);
    expect(tui.frame()).toContain("two:0");
  });

  test("the deprecated { state, dispatch } value still serves the hooks, for external plugin tests", async () => {
    const dispatch: Dispatch<AppAction> = () => {};
    await tui.render(
      <AppContext value={{ state: createInitialState(createTickerDetailConfig("MSFT")), dispatch }}>
        <PaneInstanceProvider paneId={TEST_PANE_ID}>
          <DispatchCapture />
          <PaneTickerHarness />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 24, height: 4 },
    );
    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("MSFT:1");
    expect(capturedDispatch).toBe(dispatch);
  });

  test("does not rerender usePaneTicker consumers for unrelated app state updates", async () => {
    await tui.render(
      <AppProvider config={createTickerDetailConfig("AAPL")}>
        <PaneInstanceProvider paneId={TEST_PANE_ID}>
          <DispatchCapture />
          <PaneTickerHarness />
        </PaneInstanceProvider>
      </AppProvider>,
      { width: 24, height: 4 },
    );

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("AAPL:1");

    await act(() => {
      capturedDispatch?.({ type: "SET_COMMAND_BAR", open: true, query: "ticker" });
    });

    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("AAPL:1");
  });

  test("does not dispatch or rerender when a pane setting keeps its effective value", async () => {
    await tui.render(
      <AppProvider config={createTickerDetailConfig("AAPL")}>
        <PaneInstanceProvider paneId={TEST_PANE_ID}>
          <PaneSettingHarness />
        </PaneInstanceProvider>
      </AppProvider>,
      { width: 24, height: 4 },
    );

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("table:1");

    await act(() => {
      capturedPaneSetting?.("table");
    });
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();

    expect(tui.frame()).toContain("table:1");
  });

  test("theme hook consumers follow theme changes and previews", async () => {
    await tui.render(
      <AppProvider config={createTickerDetailConfig("AAPL")}>
        <DispatchCapture />
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain(`${TEST_PANE_ID}:${DEFAULT_THEME}`);

    const dispatchAndCapture = async (action: AppAction) => {
      await act(() => {
        capturedDispatch?.(action);
      });
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
      return tui.frame();
    };

    expect(await dispatchAndCapture({ type: "PREVIEW_THEME", theme: "green" })).toContain(`${TEST_PANE_ID}:green`);

    // Committing a theme clears the active preview.
    const committed = await dispatchAndCapture({ type: "SET_THEME", theme: "red" });
    expect(committed).toContain(`${TEST_PANE_ID}:red`);
    expect(committed).not.toContain(`${TEST_PANE_ID}:green`);

    expect(await dispatchAndCapture({ type: "PREVIEW_THEME", theme: "green" })).toContain(`${TEST_PANE_ID}:green`);
    // Clearing the preview falls back to the committed theme.
    expect(await dispatchAndCapture({ type: "PREVIEW_THEME", theme: null })).toContain(`${TEST_PANE_ID}:red`);
  });

  test.each([
    { source: "the configured theme", configTheme: "green", initialThemePreview: null },
    { source: "the initial desktop theme preview", configTheme: null, initialThemePreview: { theme: "green" } },
  ])("uses $source on the first provider render", async ({ configTheme, initialThemePreview }) => {
    const config = createTickerDetailConfig("AAPL");
    if (configTheme) config.theme = configTheme;

    await tui.render(
      <AppProvider config={config} initialThemePreview={initialThemePreview}>
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain(`${TEST_PANE_ID}:green`);
  });

  test("desktop committed theme changes still sync through the config snapshot", async () => {
    const mainSnapshots: DesktopSharedStateSnapshot[] = [];
    const themePreviews: DesktopThemePreviewState[] = [];
    const bridge = createDesktopBridge("main", { mainSnapshots, themePreviews });

    await tui.render(
      <AppProvider config={createTickerDetailConfig("AAPL")} desktopBridge={bridge}>
        <DispatchCapture />
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await tui.setup().renderOnce();
    mainSnapshots.length = 0;
    themePreviews.length = 0;

    await act(() => {
      capturedDispatch?.({ type: "SET_THEME", theme: "green" });
    });

    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
    expect(mainSnapshots).toHaveLength(1);
    expect(mainSnapshots[0]?.config.theme).toBe("green");
    expect(themePreviews).toHaveLength(0);
  });

  test("does not hydrate a stale desktop echo after a newer layout switch", async () => {
    const mainSnapshots: DesktopSharedStateSnapshot[] = [];
    let stateListener: ((snapshot: DesktopSharedStateSnapshot) => void) | null = null;
    const bridge = createDesktopBridge("main", {
      mainSnapshots,
      onStateSubscribe: (listener) => {
        stateListener = listener;
      },
    });

    await tui.render(
      <AppProvider config={createDefaultConfig("/tmp/gloomberb-layout-race")} desktopBridge={bridge}>
        <DispatchCapture />
        <ActiveLayoutHarness />
      </AppProvider>,
      { width: 24, height: 4 },
    );

    await tui.setup().renderOnce();
    const matchingNewerSnapshot = {
      ...mainSnapshots.at(-1)!,
      mainStateRevision: 10,
    };
    await act(() => {
      stateListener?.(matchingNewerSnapshot);
    });
    await act(() => {
      capturedDispatch?.({ type: "SWITCH_LAYOUT", index: 1 });
    });
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
    const staleSnapshot = mainSnapshots.at(-1)!;
    expect(staleSnapshot.config.activeLayoutIndex).toBe(1);
    expect(staleSnapshot.mainStateRevision).toBe(11);

    await act(() => {
      capturedDispatch?.({ type: "SWITCH_LAYOUT", index: 0 });
    });
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
    expect(mainSnapshots.at(-1)?.config.activeLayoutIndex).toBe(0);
    expect(mainSnapshots.at(-1)!.mainStateRevision).toBeGreaterThan(staleSnapshot.mainStateRevision!);

    await act(() => {
      stateListener?.(staleSnapshot);
    });
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();

    expect(tui.frame()).toContain("layout:0");
  });

  test("desktop detached windows apply theme preview messages locally", async () => {
    let previewListener: ((preview: DesktopThemePreviewState) => void) | null = null;
    const bridge = createDesktopBridge("detached", {
      onThemePreviewSubscribe: (listener) => {
        previewListener = listener;
      },
    });

    await tui.render(
      <AppProvider config={createTickerDetailConfig("AAPL")} desktopBridge={bridge}>
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await tui.setup().renderOnce();
    expect(previewListener).not.toBeNull();
    expect(tui.frame()).toContain(`${TEST_PANE_ID}:${DEFAULT_THEME}`);

    await act(() => {
      previewListener?.({ theme: "green" });
    });

    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
    expect(tui.frame()).toContain(`${TEST_PANE_ID}:green`);
  });
});
