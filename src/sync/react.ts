import { useEffect, useSyncExternalStore, type Dispatch } from "react";
import type { AppAction, AppState } from "../core/state/app/state";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import type { PluginRegistry } from "../plugins/registry";
import { cloudSyncController } from "./controller";

interface CloudSyncRuntimeOptions {
  state: AppState;
  getState: () => AppState;
  dispatch: Dispatch<AppAction>;
  tickerRepository: AppTickerRepositoryPort;
  pluginRegistry: PluginRegistry;
  initialized: boolean;
}

export function useCloudSyncRuntime({
  state,
  getState,
  dispatch,
  tickerRepository,
  pluginRegistry,
  initialized,
}: CloudSyncRuntimeOptions): void {
  useEffect(() => {
    return cloudSyncController.setRuntime({
      getState,
      dispatch,
      tickerRepository,
      getContributors: () => pluginRegistry.getEnabledSyncContributors(),
      getTransport: () => pluginRegistry.getActiveSyncTransport(),
    });
  }, [dispatch, getState, pluginRegistry, tickerRepository]);

  useEffect(() => {
    if (!initialized) return;
    void cloudSyncController.requestSync({ reason: "startup" });
  }, [initialized, pluginRegistry]);

  useEffect(() => {
    if (!initialized) return;
    cloudSyncController.schedulePush("state-change");
  }, [initialized, state.config, state.tickers]);
}

export function useCloudSyncStatus() {
  return useSyncExternalStore(
    (listener) => cloudSyncController.subscribe(listener),
    () => cloudSyncController.getStatus(),
    () => cloudSyncController.getStatus(),
  );
}
