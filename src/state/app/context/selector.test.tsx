import { afterEach, describe, expect, test } from "bun:test";
import { act, useRef, type Dispatch } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppProvider, PaneInstanceProvider, useAppDispatch, useAppSelector, usePaneSettingValue, usePaneTicker, type AppAction } from "./index";
import { cloneLayout, createDefaultConfig, type AppConfig } from "../../../types/config";
import { applyTheme } from "../../../theme/colors";
import { useThemeId } from "../../../theme/theme-context";
import type { DesktopSharedStateSnapshot, DesktopThemePreviewState, DesktopWindowBridge } from "../../../types/desktop-window";

const TEST_PANE_ID = "ticker-detail:test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
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
  afterEach(async () => {
    if (testSetup) {
      await act(async () => {
        testSetup!.renderer.destroy();
      });
    }
    testSetup = undefined;
    capturedDispatch = null;
    capturedPaneSetting = null;
    applyTheme("amber");
  });

  test("does not rerender usePaneTicker consumers for unrelated app state updates", async () => {
    testSetup = await testRender(
      <AppProvider config={createTickerDetailConfig("AAPL")}>
        <PaneInstanceProvider paneId={TEST_PANE_ID}>
          <DispatchCapture />
          <PaneTickerHarness />
        </PaneInstanceProvider>
      </AppProvider>,
      { width: 24, height: 4 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("AAPL:1");

    await act(() => {
      capturedDispatch?.({ type: "SET_COMMAND_BAR", open: true, query: "ticker" });
    });

    await testSetup.renderOnce();
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("AAPL:1");
  });

  test("does not dispatch or rerender when a pane setting keeps its effective value", async () => {
    testSetup = await testRender(
      <AppProvider config={createTickerDetailConfig("AAPL")}>
        <PaneInstanceProvider paneId={TEST_PANE_ID}>
          <PaneSettingHarness />
        </PaneInstanceProvider>
      </AppProvider>,
      { width: 24, height: 4 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("table:1");

    await act(() => {
      capturedPaneSetting?.("table");
    });
    await testSetup.renderOnce();
    await testSetup.renderOnce();

    expect(testSetup.captureCharFrame()).toContain("table:1");
  });

  test("rerenders theme hook consumers when the theme changes", async () => {
    testSetup = await testRender(
      <AppProvider config={createTickerDetailConfig("AAPL")}>
        <DispatchCapture />
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain(`${TEST_PANE_ID}:amber`);

    await act(() => {
      capturedDispatch?.({ type: "SET_THEME", theme: "green" });
    });

    await testSetup.renderOnce();
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain(`${TEST_PANE_ID}:green`);
  });

  test("rerenders theme hook consumers when the theme preview changes", async () => {
    testSetup = await testRender(
      <AppProvider config={createTickerDetailConfig("AAPL")}>
        <DispatchCapture />
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain(`${TEST_PANE_ID}:amber`);

    await act(() => {
      capturedDispatch?.({ type: "PREVIEW_THEME", theme: "green" });
    });

    await testSetup.renderOnce();
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain(`${TEST_PANE_ID}:green`);
  });

  test("set theme updates the theme hook and clears the active preview", async () => {
    testSetup = await testRender(
      <AppProvider config={createTickerDetailConfig("AAPL")}>
        <DispatchCapture />
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await testSetup.renderOnce();
    await act(() => {
      capturedDispatch?.({ type: "PREVIEW_THEME", theme: "green" });
    });
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain(`${TEST_PANE_ID}:green`);

    await act(() => {
      capturedDispatch?.({ type: "SET_THEME", theme: "red" });
    });

    await testSetup.renderOnce();
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain(`${TEST_PANE_ID}:red`);
    expect(frame).not.toContain(`${TEST_PANE_ID}:green`);
  });

  test("falls back to the committed theme when theme preview clears", async () => {
    testSetup = await testRender(
      <AppProvider config={createTickerDetailConfig("AAPL")}>
        <DispatchCapture />
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await testSetup.renderOnce();
    await act(() => {
      capturedDispatch?.({ type: "PREVIEW_THEME", theme: "green" });
    });
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain(`${TEST_PANE_ID}:green`);

    await act(() => {
      capturedDispatch?.({ type: "PREVIEW_THEME", theme: null });
    });

    await testSetup.renderOnce();
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain(`${TEST_PANE_ID}:amber`);
  });

  test("uses the configured theme on the first provider render", async () => {
    const config = createTickerDetailConfig("AAPL");
    config.theme = "green";

    testSetup = await testRender(
      <AppProvider config={config}>
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain(`${TEST_PANE_ID}:green`);
  });

  test("uses the initial desktop theme preview on the first provider render", async () => {
    testSetup = await testRender(
      <AppProvider config={createTickerDetailConfig("AAPL")} initialThemePreview={{ theme: "green" }}>
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain(`${TEST_PANE_ID}:green`);
  });

  test("desktop committed theme changes still sync through the config snapshot", async () => {
    const mainSnapshots: DesktopSharedStateSnapshot[] = [];
    const themePreviews: DesktopThemePreviewState[] = [];
    const bridge = createDesktopBridge("main", { mainSnapshots, themePreviews });

    testSetup = await testRender(
      <AppProvider config={createTickerDetailConfig("AAPL")} desktopBridge={bridge}>
        <DispatchCapture />
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await testSetup.renderOnce();
    mainSnapshots.length = 0;
    themePreviews.length = 0;

    await act(() => {
      capturedDispatch?.({ type: "SET_THEME", theme: "green" });
    });

    await testSetup.renderOnce();
    await testSetup.renderOnce();
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

    testSetup = await testRender(
      <AppProvider config={createDefaultConfig("/tmp/gloomberb-layout-race")} desktopBridge={bridge}>
        <DispatchCapture />
        <ActiveLayoutHarness />
      </AppProvider>,
      { width: 24, height: 4 },
    );

    await testSetup.renderOnce();
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
    await testSetup.renderOnce();
    await testSetup.renderOnce();
    const staleSnapshot = mainSnapshots.at(-1)!;
    expect(staleSnapshot.config.activeLayoutIndex).toBe(1);
    expect(staleSnapshot.mainStateRevision).toBe(11);

    await act(() => {
      capturedDispatch?.({ type: "SWITCH_LAYOUT", index: 0 });
    });
    await testSetup.renderOnce();
    await testSetup.renderOnce();
    expect(mainSnapshots.at(-1)?.config.activeLayoutIndex).toBe(0);
    expect(mainSnapshots.at(-1)!.mainStateRevision).toBeGreaterThan(staleSnapshot.mainStateRevision!);

    await act(() => {
      stateListener?.(staleSnapshot);
    });
    await testSetup.renderOnce();
    await testSetup.renderOnce();

    expect(testSetup.captureCharFrame()).toContain("layout:0");
  });

  test("desktop detached windows apply theme preview messages locally", async () => {
    let previewListener: ((preview: DesktopThemePreviewState) => void) | null = null;
    const bridge = createDesktopBridge("detached", {
      onThemePreviewSubscribe: (listener) => {
        previewListener = listener;
      },
    });

    testSetup = await testRender(
      <AppProvider config={createTickerDetailConfig("AAPL")} desktopBridge={bridge}>
        <ThemeSelectorHarness />
      </AppProvider>,
      { width: 32, height: 4 },
    );

    await testSetup.renderOnce();
    expect(previewListener).not.toBeNull();
    expect(testSetup.captureCharFrame()).toContain(`${TEST_PANE_ID}:amber`);

    await act(() => {
      previewListener?.({ theme: "green" });
    });

    await testSetup.renderOnce();
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain(`${TEST_PANE_ID}:green`);
  });
});
