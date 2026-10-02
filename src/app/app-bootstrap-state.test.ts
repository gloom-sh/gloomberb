import { describe, expect, test } from "bun:test";
import type { AppSessionSnapshot } from "../core/state/session-persistence";
import { createDefaultConfig, createPaneInstance } from "../types/config";
import type { DesktopSharedStateSnapshot } from "../types/desktop-window";
import type { CliLaunchRequest } from "../types/plugin";
import {
  resolveAppSessionSnapshot,
  resolveCliLaunchConfig,
  resolveInitialAppConfig,
} from "./app-bootstrap-state";

function createSessionReader(snapshot: AppSessionSnapshot | null) {
  return {
    get<T>() {
      return snapshot
        ? {
          sessionId: "app",
          value: snapshot as T,
          schemaVersion: 1,
          updatedAt: 0,
        }
        : null;
    },
  };
}

function createSessionSnapshot(overrides: Partial<AppSessionSnapshot> = {}): AppSessionSnapshot {
  return {
    paneState: {},
    focusedPaneId: "portfolio-list:main",
    statusBarVisible: true,
    openPaneIds: ["portfolio-list:main"],
    hydrationTargets: [],
    exchangeCurrencies: [],
    savedAt: 1,
    ...overrides,
  };
}

describe("app bootstrap state", () => {
  test("keeps detached panes materialized only for terminal app launches", () => {
    const config = createDefaultConfig("/tmp/gloomberb-app-bootstrap");
    config.layout.instances.push(createPaneInstance("ticker-detail", {
      instanceId: "ticker-detail:detached",
      binding: { kind: "fixed", symbol: "AAPL" },
    }));
    config.layout.detached.push({
      instanceId: "ticker-detail:detached",
      x: 4,
      y: 3,
      width: 60,
      height: 18,
    });

    const terminalConfig = resolveInitialAppConfig({
      initialConfig: config,
      hasDesktopWindowBridge: false,
    });
    expect(terminalConfig.layout.detached).toEqual([]);
    expect(terminalConfig.layout.floating).toContainEqual({
      instanceId: "ticker-detail:detached",
      x: 4,
      y: 3,
      width: 60,
      height: 18,
    });

    const desktopConfig = resolveInitialAppConfig({
      initialConfig: config,
      hasDesktopWindowBridge: true,
    });
    expect(desktopConfig).toBe(config);
    expect(desktopConfig.layout.detached).toHaveLength(1);
  });

  test("applies CLI launch config before the app provider boots", () => {
    const config = createDefaultConfig("/tmp/gloomberb-cli-bootstrap");
    const request: CliLaunchRequest<{ paneInstanceId: string }> = {
      applyConfig(baseConfig, env) {
        return {
          config: {
            ...baseConfig,
            refreshIntervalMinutes: env.terminalWidth,
          },
          launchState: { paneInstanceId: `height:${env.terminalHeight}` },
        };
      },
    };

    const result = resolveCliLaunchConfig({
      cliLaunchRequest: request,
      config,
      terminalWidth: 120,
      terminalHeight: 40,
    });

    expect(result.config.refreshIntervalMinutes).toBe(120);
    expect(result.launchState).toEqual({ paneInstanceId: "height:40" });
  });

  test("overlays detached window state on the persisted app session", () => {
    const config = createDefaultConfig("/tmp/gloomberb-detached-bootstrap");
    const persisted = createSessionSnapshot({
      paneState: { "portfolio-list:main": { cursorSymbol: "MSFT" } },
      statusBarVisible: true,
    });
    const desktopSnapshot: DesktopSharedStateSnapshot = {
      config,
      paneState: { "ticker-detail:main": { cursorSymbol: "AAPL" } },
      focusedPaneId: "ticker-detail:main",
      statusBarVisible: false,
    };

    const result = resolveAppSessionSnapshot({
      config,
      cliLaunchState: undefined,
      desktopSnapshot,
      desktopWindowKind: "detached",
      sessionStore: createSessionReader(persisted),
    });

    expect(result?.paneState).toEqual({ "ticker-detail:main": { cursorSymbol: "AAPL" } });
    expect(result?.focusedPaneId).toBe("ticker-detail:main");
    expect(result?.statusBarVisible).toBe(false);
    expect(result?.openPaneIds).toEqual(["portfolio-list:main"]);
  });

  test("lets CLI launches adjust the reconciled main-window session", () => {
    const config = createDefaultConfig("/tmp/gloomberb-main-bootstrap");
    const persisted = createSessionSnapshot();
    const request: CliLaunchRequest<string> = {
      applyConfig(baseConfig) {
        return { config: baseConfig };
      },
      applySessionSnapshot(_config, snapshot, launchState) {
        return {
          ...snapshot!,
          focusedPaneId: launchState ?? snapshot?.focusedPaneId ?? null,
        };
      },
    };

    const result = resolveAppSessionSnapshot({
      config,
      cliLaunchRequest: request,
      cliLaunchState: "ticker-detail:main",
      sessionStore: createSessionReader(persisted),
    });

    expect(result?.focusedPaneId).toBe("ticker-detail:main");
    expect(result?.openPaneIds).toEqual(["portfolio-list:main"]);
  });
});
