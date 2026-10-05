import { useCallback, useEffect, type Dispatch } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import { saveConfigImmediately } from "../../state/config-save-scheduler";
import type { AppAction, AppState } from "../../state/app/context";
import {
  canSelfUpdate,
  checkForUpdateDetailed,
  performUpdate,
  type ReleaseInfo,
  type UpdateCheckResult,
} from "../../updater";
import { VERSION } from "../../version";
import { reportCrash } from "../../telemetry/crash-reports";
import { runAutomated } from "../../telemetry/usage-counts";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000; // hourly

export function useAppUpdateRuntime({
  enabled = true,
  dispatch,
  isDetachedWindow,
  pluginRegistry,
  stateRef,
  updateAvailable,
  updateCheckInProgress,
  updateProgress,
}: {
  enabled?: boolean;
  dispatch: Dispatch<AppAction>;
  isDetachedWindow: boolean;
  pluginRegistry: PluginRegistry;
  stateRef: { current: AppState };
  updateAvailable: ReleaseInfo | null;
  updateCheckInProgress: boolean;
  updateProgress: unknown;
}): {
  runUpdateCheck: (manual?: boolean) => Promise<void>;
  startUpdate: (release: ReleaseInfo) => void;
} {
  const startUpdate = useCallback((release: ReleaseInfo) => {
    dispatch({ type: "SET_UPDATE_PROGRESS", progress: { phase: "downloading", percent: 0 } });
    void performUpdate(release, (progress) => {
      dispatch({ type: "SET_UPDATE_PROGRESS", progress });
    });
  }, [dispatch]);

  const runUpdateCheck = useCallback(async (manual = false) => {
    if (manual) {
      dispatch({ type: "SET_UPDATE_CHECK_IN_PROGRESS", checking: true });
      dispatch({ type: "SET_UPDATE_NOTICE", notice: null });
    }

    // The desktop host can reject (its RPC request timed out). That is a
    // failed check like any other: the hourly one must not end as an
    // unhandled rejection, and a manual one must clear its progress state.
    // The timeout is still reported, as it was when it went unhandled.
    const result = await checkForUpdateDetailed(VERSION).catch((error: unknown): UpdateCheckResult => {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("RPC request timed out")) {
        reportCrash(error, { kind: "unhandled-rejection" });
      }
      return { kind: "error", error: message || "Update check failed" };
    });

    if (!manual) {
      if (result.kind === "available") {
        dispatch({ type: "SET_UPDATE_AVAILABLE", release: result.release });
      }
      return;
    }

    dispatch({ type: "SET_UPDATE_CHECK_IN_PROGRESS", checking: false });

    if (result.kind === "available") {
      dispatch({ type: "SET_UPDATE_AVAILABLE", release: result.release });
      return;
    }

    if (result.kind === "current") {
      dispatch({ type: "SET_UPDATE_AVAILABLE", release: null });
      dispatch({ type: "SET_UPDATE_NOTICE", notice: `Already on v${VERSION}` });
      return;
    }

    if (result.kind === "disabled") {
      dispatch({ type: "SET_UPDATE_NOTICE", notice: "Update checks are unavailable in source mode" });
      return;
    }

    dispatch({ type: "SET_UPDATE_NOTICE", notice: `Update check failed: ${result.error}` });
  }, [dispatch]);

  useEffect(() => {
    if (!enabled || isDetachedWindow) return;
    void runUpdateCheck(false);
    const interval = setInterval(() => { void runUpdateCheck(false); }, UPDATE_CHECK_INTERVAL_MS);
    return () => { clearInterval(interval); };
  }, [enabled, isDetachedWindow, runUpdateCheck]);

  // First launch on a new version: show that release's notes, then remember the version.
  useEffect(() => {
    if (!enabled || isDetachedWindow) return;
    const config = stateRef.current.config;
    if (config.lastLaunchedVersion === VERSION) return;
    const isUpgrade = !!config.lastLaunchedVersion;
    const nextConfig = { ...config, lastLaunchedVersion: VERSION };
    dispatch({ type: "SET_CONFIG", config: nextConfig });
    void saveConfigImmediately(nextConfig).catch(() => {});
    if (!isUpgrade) return;
    // Opened by the app, not the user: usage counts leave it out.
    void runAutomated(() => pluginRegistry.createPaneFromTemplateAsync("changelog-pane", {
      values: { version: VERSION },
    })).catch(() => {});
  }, [dispatch, enabled, isDetachedWindow, pluginRegistry, stateRef]);

  useEffect(() => {
    if (!enabled || isDetachedWindow) return;
    if (!updateAvailable || updateProgress || updateCheckInProgress) return;
    if (!canSelfUpdate(updateAvailable)) return;
    startUpdate(updateAvailable);
  }, [enabled, isDetachedWindow, startUpdate, updateAvailable, updateCheckInProgress, updateProgress]);

  return {
    runUpdateCheck,
    startUpdate,
  };
}
