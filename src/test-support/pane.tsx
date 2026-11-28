import { useMemo, type Dispatch, type ReactNode } from "react";
import { AppContext, PaneInstanceProvider, type AppAction, type AppState } from "../state/app/context";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../plugins/runtime";
import { createStaticAppStore } from "./app-store";
import { cloneLayout, createDefaultConfig, type AppConfig, type PaneInstanceConfig } from "../types/config";


interface TestPaneProviderProps {
  state: AppState;
  dispatch?: Dispatch<AppAction>;
  paneId: string;
  pluginId: string;
  runtime: PluginRuntimeAccess;
  children: ReactNode;
}

/** Provider wiring only: the suite retains ownership of its state and update timing. */
export function TestPaneProvider({
  state, dispatch, paneId, pluginId, runtime, children,
}: TestPaneProviderProps) {
  const store = useMemo(() => createStaticAppStore(state, dispatch), [state, dispatch]);
  return (
    <AppContext value={store}>
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
