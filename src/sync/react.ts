import { useEffect, useMemo, useSyncExternalStore, type Dispatch } from "react";
import type { AppAction, AppState } from "../core/state/app/state";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import { apiClient } from "../api-client";
import type { PluginRegistry } from "../plugins/registry";
import { subscribeToCloudVerification } from "./auth-transition";
import { createSyncBaselineStore } from "./baseline";
import { cloudSyncController } from "./controller";

const CLOUD_SYNC_POLL_MS = 15_000;

interface CloudSyncRuntimeOptions {
  state: AppState;
  getState: () => AppState;
  dispatch: Dispatch<AppAction>;
  tickerRepository: AppTickerRepositoryPort;
  pluginRegistry: PluginRegistry;
  initialized: boolean;
  appActive?: boolean;
}

export function useCloudSyncRuntime({
  state,
  getState,
  dispatch,
  tickerRepository,
  pluginRegistry,
  initialized,
  appActive = true,
}: CloudSyncRuntimeOptions): void {
  const baselineStore = useMemo(
    () => createSyncBaselineStore(pluginRegistry.persistence.pluginState),
    [pluginRegistry],
  );

  useEffect(() => {
    return cloudSyncController.setRuntime({
      getState,
      dispatch,
      tickerRepository,
      baselineStore,
      getContributors: () => pluginRegistry.getEnabledSyncContributors(),
      getTransport: () => pluginRegistry.getActiveSyncTransport(),
    });
  }, [baselineStore, dispatch, getState, pluginRegistry, tickerRepository]);

  useEffect(() => {
    if (!initialized) return;
    void cloudSyncController.requestSync({ reason: "startup" });
  }, [initialized, pluginRegistry]);

  useEffect(() => {
    if (!initialized || !appActive) return;
    void cloudSyncController.requestSync({ reason: "foreground" });
    const timer = setInterval(() => {
      void cloudSyncController.requestSync({ reason: "poll" });
    }, CLOUD_SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [appActive, initialized]);

  useEffect(() => subscribeToCloudVerification(apiClient, () => {
    if (!initialized) return;
    // Email verification makes the Cloud transport available. Force the first
    // sync so a workspace completed before verification is uploaded promptly.
    void cloudSyncController.requestSync({ reason: "session-verified", force: true });
  }), [initialized]);

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
