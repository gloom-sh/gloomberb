import type { Dispatch, ReactNode } from "react";
import { AppContext, PaneInstanceProvider, type AppAction, type AppState } from "../state/app/context";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../plugins/runtime";
import { cloneLayout, createDefaultConfig, type AppConfig, type PaneInstanceConfig } from "../types/config";
import type { TickerRecord } from "../types/ticker";

/** Provider wiring only: the suite retains ownership of its state and update timing. */
export function TestPaneProvider({
  state, dispatch = () => {}, paneId, pluginId, runtime, children,
}: {
  state: AppState;
  dispatch?: Dispatch<AppAction>;
  paneId: string;
  pluginId: string;
  runtime: PluginRuntimeAccess;
  children: ReactNode;
}) {
  return (
    <AppContext value={{ state, dispatch }}>
      <PaneInstanceProvider paneId={paneId}>
        <PluginRenderProvider pluginId={pluginId} runtime={runtime}>
          {children}
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

export function createTestPaneConfig(dataDir: string, instance: PaneInstanceConfig): AppConfig {
  const layout: AppConfig["layout"] = {
    dockRoot: { kind: "pane", instanceId: instance.instanceId },
    instances: [instance], floating: [], detached: [],
  };
  return {
    ...createDefaultConfig(dataDir), layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  };
}

export function createTestTicker(
  symbol: string,
  name = symbol,
  overrides: Partial<TickerRecord["metadata"]> = {},
): TickerRecord {
  return {
    metadata: {
      ticker: symbol, exchange: "NASDAQ", currency: "USD", name,
      portfolios: [], watchlists: [], positions: [], custom: {}, tags: [],
      ...overrides,
    },
  };
}
