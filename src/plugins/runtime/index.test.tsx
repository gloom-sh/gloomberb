import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect, useReducer, type SetStateAction } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import {
  AppContext,
  PaneInstanceProvider,
  appReducer,
  createInitialState,
} from "../../state/app/context";
import { createConfigBackedTestPluginRuntime, createTestPluginRuntime } from "../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../types/config";
import {
  PluginRenderProvider,
  deletePluginPaneStateValue,
  getPluginPaneStateValue,
  setPluginPaneStateValue,
  useDebouncedPluginPaneState,
  usePluginConfigState,
  usePluginPaneState,
  usePluginState,
  usePluginTickerActions,
  useSetPluginConfigStates,
} from "./index";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

describe("plugin runtime helpers", () => {
  test("reads, writes, and deletes nested pane state under the plugin namespace", () => {
    const initial = {
      pluginState: {
        news: {
          selected: 2,
        },
      },
    };

    expect(getPluginPaneStateValue(initial, "news", "selected", 0)).toBe(2);
    expect(getPluginPaneStateValue(initial, "news", "missing", 0)).toBe(0);
    expect(setPluginPaneStateValue(initial, "news", "expanded", true)).toEqual({
      news: {
        selected: 2,
        expanded: true,
      },
    });
    expect(deletePluginPaneStateValue(initial, "news", "selected")).toBeUndefined();
  });
});

describe("plugin runtime hooks", () => {
  test("debounces pane state commits", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-plugin-runtime-debounce");
    const stateRef: { current: ReturnType<typeof createInitialState> | null } = { current: null };
    let setSelection: ((value: SetStateAction<string>) => void) | null = null;

    const runtime = createTestPluginRuntime();

    function HookHarness() {
      const [state, dispatch] = useReducer(appReducer, createInitialState(config));
      stateRef.current = state;

      return (
        <AppContext value={{ state, dispatch }}>
          <PaneInstanceProvider paneId="prediction-markets:main">
            <PluginRenderProvider pluginId="prediction-markets" runtime={runtime}>
              <HookProbe />
            </PluginRenderProvider>
          </PaneInstanceProvider>
        </AppContext>
      );
    }

    function HookProbe() {
      const [selection, setDebouncedSelection] = useDebouncedPluginPaneState("selectedRowKey", "row-a", 20);
      setSelection = setDebouncedSelection;
      return <text>{selection}</text>;
    }

    testSetup = await testRender(<HookHarness />, { width: 40, height: 5 });

    await act(async () => {
      await testSetup!.renderOnce();
    });

    await act(async () => {
      setSelection?.("row-b");
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(
      stateRef.current?.paneState["prediction-markets:main"]?.pluginState?.["prediction-markets"]?.selectedRowKey,
    ).toBeUndefined();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await testSetup!.renderOnce();
    });

    expect(
      stateRef.current?.paneState["prediction-markets:main"]?.pluginState?.["prediction-markets"]?.selectedRowKey,
    ).toBe("row-b");
  });

  test("updates pane, global resume, and config state through the plugin hooks", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-plugin-runtime");
    const stateRef: { current: ReturnType<typeof createInitialState> | null } = { current: null };
    const dispatchRef: { current: React.Dispatch<any> | null } = { current: null };
    const runtime = createConfigBackedTestPluginRuntime({
      getConfig: () => stateRef.current?.config,
      setConfig: (config) => dispatchRef.current?.({ type: "SET_CONFIG", config }),
    });

    function HookHarness() {
      const [state, dispatch] = useReducer(appReducer, createInitialState(config));
      stateRef.current = state;
      dispatchRef.current = dispatch;

      return (
        <AppContext value={{ state, dispatch }}>
          <PaneInstanceProvider paneId="portfolio-list:main">
            <PluginRenderProvider pluginId="news" runtime={runtime}>
              <HookProbe />
            </PluginRenderProvider>
          </PaneInstanceProvider>
        </AppContext>
      );
    }

    function HookProbe() {
      const [paneSelection, setPaneSelection] = usePluginPaneState<number>("selectedIdx", 0);
      const [venueScope, setVenueScope] = usePluginPaneState<string>("venueScope", "all");
      const [provider, setProvider] = usePluginState<string>("provider", "claude");
      const [mode, setMode] = usePluginConfigState<string>("displayMode", "compact");
      const [layoutMode] = usePluginConfigState<string>("layoutMode", "default");
      const setConfigStates = useSetPluginConfigStates();

      useEffect(() => {
        if (paneSelection === 0) setPaneSelection(3);
        if (venueScope === "all") setVenueScope("kalshi");
        if (provider === "claude") setProvider("codex");
        if (mode === "compact") {
          setMode("expanded");
        } else if (layoutMode === "default") {
          setConfigStates({ layoutMode: "wide", density: "dense" });
        }
      }, [
        layoutMode,
        mode,
        paneSelection,
        provider,
        setConfigStates,
        setMode,
        setPaneSelection,
        setProvider,
        setVenueScope,
        venueScope,
      ]);

      return <text>{`${paneSelection}|${venueScope}|${provider}|${mode}|${layoutMode}`}</text>;
    }

    testSetup = await testRender(<HookHarness />, { width: 40, height: 5 });

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("3|kalshi|codex|expanded|wide");
    expect(stateRef.current?.paneState["portfolio-list:main"]?.pluginState).toEqual({
      news: {
        selectedIdx: 3,
        venueScope: "kalshi",
      },
    });
    expect(stateRef.current?.config.pluginConfig.news).toEqual({
      density: "dense",
      displayMode: "expanded",
      layoutMode: "wide",
    });
    expect(runtime.getResumeState("news", "provider")).toBe("codex");
  });

  test("scopes ticker navigation to the rendering pane", async () => {
    const calls: string[] = [];
    let actions: ReturnType<typeof usePluginTickerActions> | null = null;

    const runtime = createTestPluginRuntime({
      navigateTicker(symbol: string, options?: { sourcePaneId?: string | null }) {
        calls.push(`${symbol}:${options?.sourcePaneId ?? ""}`);
      },
    });

    function HookProbe() {
      actions = usePluginTickerActions();
      return <text>ticker-actions</text>;
    }

    testSetup = await testRender(
      <PaneInstanceProvider paneId="comparison-chart:main">
        <PluginRenderProvider pluginId="market-overview" runtime={runtime}>
          <HookProbe />
        </PluginRenderProvider>
      </PaneInstanceProvider>,
      { width: 40, height: 5 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });

    actions?.navigateTicker("MSFT");

    expect(calls).toEqual(["MSFT:comparison-chart:main"]);
  });
});
