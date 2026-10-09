import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, useSyncExternalStore, type ReactNode } from "react";
import type { CrashReportsPayload } from "../../../api-client";
import { getPluginHealth } from "../../../plugins/health";
import type { PluginRegistry } from "../../../plugins/registry";
import { setSharedRegistryForTests } from "../../../plugins/registry/shared";
import { createOpenTuiTestHarness, TestDialogProvider } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { flushCrashReports, installCrashReporter, resetCrashReporterForTests } from "../../../telemetry/crash-reports";
import { createStaticAppStore } from "../../../test-support/app-store";
import { cloneLayout, createDefaultConfig, TICKER_RESEARCH_PANE_ID, type LayoutConfig } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { DetachedPaneShell } from "../detached-pane-shell";
import { Shell } from "../shell";

const tui = createOpenTuiTestHarness();

/** A value outside React, so a test can change what a pane renders after it mounted. */
function createSwitch<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const broken = createSwitch(false);
const siblingTick = createSwitch(1);

function ThrowingPane(_props: PaneProps) {
  if (useSyncExternalStore(broken.subscribe, broken.get)) throw new Error("quote table is undefined");
  return <text>Research Body</text>;
}

function SiblingPane(_props: PaneProps) {
  return <text>{`Sibling ${useSyncExternalStore(siblingTick.subscribe, siblingTick.get)}`}</text>;
}

function registryWith(panes: { docked: (props: PaneProps) => ReactNode; floating: (props: PaneProps) => ReactNode }): PluginRegistry {
  return {
    panes: new Map([
      ["portfolio-list", { id: "portfolio-list", name: "Portfolio List", component: panes.docked, defaultPosition: "left" }],
      [TICKER_RESEARCH_PANE_ID, {
        id: TICKER_RESEARCH_PANE_ID,
        name: "Ticker Research",
        component: panes.floating,
        defaultPosition: "right",
        defaultMode: "floating",
      }],
    ]),
    paneTemplates: new Map(),
    commands: new Map(),
    getEnabledTickerActions: () => [],
    tickerActions: new Map(),
    brokers: new Map(),
    allPlugins: new Map(),
    getPluginPaneIds: () => [],
    getPluginPaneTemplateIds: () => [],
    hasPaneSettings: () => false,
    notify: () => {},
    openPaneSettings: () => {},
    openCommandBar: () => {},
    showPane: () => {},
    openWindowMode: () => {},
    updateLayout: () => {},
    hidePane: () => {},
    resolvePaneQuickSettings: () => [],
    bindHost() { return () => {}; },
  } as unknown as PluginRegistry;
}

/** Portfolio docked, Ticker Research floating over its lower half (or in its own window). */
function paneErrorState(focusedPaneId: string, detached = false) {
  const config = createDefaultConfig("/tmp/gloomberb-pane-error-test");
  const mainPane = config.layout.instances.find((entry) => entry.instanceId === "portfolio-list:main")!;
  const detailPane = config.layout.instances.find((entry) => entry.instanceId === "ticker-detail:main")!;
  const layout: LayoutConfig = {
    dockRoot: { kind: "pane", instanceId: mainPane.instanceId },
    instances: [{ ...mainPane }, { ...detailPane }],
    floating: detached ? [] : [{ instanceId: detailPane.instanceId, x: 2, y: 6, width: 56, height: 10 }],
    detached: detached ? [{ instanceId: detailPane.instanceId, x: 0, y: 0, width: 60, height: 20 }] : [],
  };
  return {
    ...createInitialState({ ...config, layout, layouts: [{ name: "Default", layout: cloneLayout(layout) }] }),
    focusedPaneId,
  };
}

async function renderShell(registry: PluginRegistry, focusedPaneId: string) {
  const state = paneErrorState(focusedPaneId);
  const actions: Array<{ type: string; [key: string]: any }> = [];
  await tui.render(
    <AppContext value={createStaticAppStore(state, (action) => actions.push(action))}>
      <TestDialogProvider>
        <Shell pluginRegistry={registry} />
      </TestDialogProvider>
    </AppContext>,
    { width: 60, height: 20 },
  );
  await tui.setup().renderOnce();
  return actions;
}

async function flip<T>(target: ReturnType<typeof createSwitch<T>>, value: T) {
  await act(async () => {
    target.set(value);
    await tui.setup().renderOnce();
  });
  await tui.renderFrames(2);
}

describe("pane error boundary", () => {
  beforeEach(() => {
    // Set before anything mounts, so no pane is listening.
    broken.set(false);
    siblingTick.set(1);
    // React logs every error a boundary catches; the assertions below are the check.
    spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    (console.error as unknown as { mockRestore(): void }).mockRestore();
    resetCrashReporterForTests();
    setSharedRegistryForTests(undefined);
  });

  test("a pane that throws shows its failure card while the pane beside it keeps rendering", async () => {
    const actions = await renderShell(registryWith({ docked: SiblingPane, floating: ThrowingPane }), "ticker-detail:main");
    await tui.waitForFrameToContain("Research Body");

    await flip(broken, true);
    const frame = await tui.waitForFrameToContain("stopped working.");
    expect(frame).toContain("quote table is undefined");
    expect(frame).toContain("Reload pane");
    expect(frame).not.toContain("Research Body");

    await flip(siblingTick, 2);
    expect(await tui.waitForFrameToContain("Sibling 2")).toContain("stopped working.");

    await tui.clickFrameText("Close pane");
    const updateLayout = actions.find((action) => action.type === "UPDATE_LAYOUT");
    expect(updateLayout?.layout.floating).toEqual([]);
    expect(updateLayout?.layout.instances.map((instance: { instanceId: string }) => instance.instanceId)).toEqual(["portfolio-list:main"]);
  });

  test("Reload remounts the pane once it stops throwing, and the failure is reported once", async () => {
    const sent: CrashReportsPayload[] = [];
    installCrashReporter({
      surface: "terminal",
      isEnabled: () => true,
      getInstallId: () => "test-install",
      send: async (payload) => { sent.push(payload); },
    });
    setSharedRegistryForTests({ getPanePluginId: (paneId: string) => (paneId === "portfolio-list" ? "crash-plugin" : undefined) } as unknown as PluginRegistry);
    await renderShell(registryWith({ docked: ThrowingPane, floating: SiblingPane }), "portfolio-list:main");

    await flip(broken, true);
    await tui.waitForFrameToContain("stopped working.");

    // Still broken: the card comes back, and nothing loops.
    await tui.clickFrameText("Reload pane");
    await tui.renderFrames(2);
    expect(await tui.waitForFrameToContain("stopped working.")).toContain("Sibling 1");

    broken.set(false);
    await tui.clickFrameText("Reload pane");
    const frame = await tui.waitForFrameToContain("Research Body");
    expect(frame).not.toContain("stopped working.");

    await flushCrashReports({ timeoutMs: 500 });
    const errors = sent.flatMap((payload) => payload.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "render", pane: "portfolio-list", plugin: "crash-plugin", message: "quote table is undefined" });
    expect(getPluginHealth("crash-plugin").errorCount).toBe(1);
  });

  test("a detached window shows the card and closes through its window", async () => {
    const closed: string[] = [];
    broken.set(true);
    await tui.render(
      <AppContext value={createStaticAppStore(paneErrorState("ticker-detail:main", true), () => {})}>
        <TestDialogProvider>
          <DetachedPaneShell
            pluginRegistry={registryWith({ docked: SiblingPane, floating: ThrowingPane })}
            desktopWindowBridge={{
              kind: "detached",
              paneId: "ticker-detail:main",
              subscribeState: () => () => {},
              closeDetachedPane: async (paneId) => { closed.push(paneId); },
            }}
          />
        </TestDialogProvider>
      </AppContext>,
      { width: 60, height: 20 },
    );
    await tui.waitForFrameToContain("stopped working.");
    await tui.clickFrameText("Close pane");
    expect(closed).toEqual(["ticker-detail:main"]);
  });
});
