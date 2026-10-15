import { useCallback, useEffect, useRef, type Dispatch } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import { saveConfigImmediately } from "../../state/config-save-scheduler";
import type { AppAction, AppState } from "../../state/app/context";
import {
  applyUpdate,
  canRestartToApply,
  canSelfUpdate,
  checkForUpdateDetailed,
  performUpdate,
  type ReleaseInfo,
  type UpdateCheckResult,
  type UpdateProgress,
} from "../../updater";
import { resolveUpdateChannel } from "../../updater/channel";
import type { UpdateChannel } from "../../types/config";
import { VERSION } from "../../version";
import { debugLog } from "../../utils/debug-log";
import { isPrereleaseVersion } from "../../utils/semver";
import { reportCrash } from "../../telemetry/crash-reports";
import { runAutomated } from "../../telemetry/usage-counts";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000; // hourly

const updateLog = debugLog.createLogger("update");

/**
 * The header and the command bar show a failed update's message, and the header
 * cuts it to its room: the log keeps what the updater actually said.
 */
function logUpdateFailure(progress: UpdateProgress): void {
  if (progress.phase === "error") updateLog.error("update failed", { error: progress.error });
}

/** An update is being downloaded, applied, or is downloaded and waiting for a restart. */
function updateInFlight(progress: AppState["updateProgress"]): boolean {
  return progress?.phase === "downloading" || progress?.phase === "replacing" || progress?.phase === "ready";
}

export function useAppUpdateRuntime({
  enabled = true,
  dispatch,
  isDetachedWindow,
  pluginRegistry,
  stateRef,
  updateAvailable,
  updateChannel = "stable",
  updateCheckInProgress,
  updateProgress,
}: {
  enabled?: boolean;
  dispatch: Dispatch<AppAction>;
  isDetachedWindow: boolean;
  pluginRegistry: PluginRegistry;
  stateRef: { current: AppState };
  updateAvailable: ReleaseInfo | null;
  /** The channel in effect (`resolveUpdateChannel`); a change checks again at once. */
  updateChannel?: UpdateChannel;
  updateCheckInProgress: boolean;
  updateProgress: unknown;
}): {
  runUpdateCheck: (manual?: boolean) => Promise<void>;
  startUpdate: (release: ReleaseInfo) => void;
  /** Installs the downloaded desktop update and relaunches. Does nothing unless one is ready. */
  restartToApplyUpdate: () => void;
  /** The command bar's Check for Updates: restarts into a downloaded update, otherwise checks. */
  runUpdateCommand: () => void;
} {
  const restartingRef = useRef(false);

  const startUpdate = useCallback((release: ReleaseInfo) => {
    dispatch({ type: "SET_UPDATE_PROGRESS", progress: { phase: "downloading", percent: 0 } });
    void performUpdate(release, (progress) => {
      logUpdateFailure(progress);
      dispatch({ type: "SET_UPDATE_PROGRESS", progress });
    });
  }, [dispatch]);

  const restartToApplyUpdate = useCallback(() => {
    if (!enabled || isDetachedWindow) return;
    // The app relaunches here, so this must only ever follow the user's own
    // request, and a second one while the first is working changes nothing.
    if (restartingRef.current || !canRestartToApply(stateRef.current.updateProgress)) return;
    restartingRef.current = true;
    dispatch({ type: "SET_UPDATE_PROGRESS", progress: { phase: "replacing" } });
    void applyUpdate((progress) => {
      if (progress.phase === "error") restartingRef.current = false;
      logUpdateFailure(progress);
      dispatch({ type: "SET_UPDATE_PROGRESS", progress });
    });
  }, [dispatch, enabled, isDetachedWindow, stateRef]);

  const runUpdateCheck = useCallback(async (manual = false) => {
    // A staged update is the answer until it is applied: another check would
    // swap the release under the "ready" state, and the host has nothing to add.
    if (updateInFlight(stateRef.current.updateProgress)) return;
    if (manual) {
      dispatch({ type: "SET_UPDATE_CHECK_IN_PROGRESS", checking: true });
      dispatch({ type: "SET_UPDATE_NOTICE", notice: null });
    }

    // The desktop host can reject (its RPC request timed out). That is a
    // failed check like any other: the hourly one must not end as an
    // unhandled rejection, and a manual one must clear its progress state.
    // The timeout is still reported, as it was when it went unhandled.
    const channel = resolveUpdateChannel(stateRef.current.config);
    const result = await checkForUpdateDetailed(VERSION, channel).catch((error: unknown): UpdateCheckResult => {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("RPC request timed out")) {
        reportCrash(error, { kind: "unhandled-rejection" });
      }
      return { kind: "error", error: message || "Update check failed" };
    });

    if (result.kind === "error") updateLog.warn("update check failed", { error: result.error });

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
      dispatch({ type: "SET_UPDATE_NOTICE", notice: result.notice ?? `Already on v${VERSION}` });
      return;
    }

    if (result.kind === "disabled") {
      dispatch({ type: "SET_UPDATE_NOTICE", notice: "Update checks are unavailable in source mode" });
      return;
    }

    dispatch({ type: "SET_UPDATE_NOTICE", notice: `Update check failed: ${result.error}` });
  }, [dispatch, stateRef]);

  const runUpdateCommand = useCallback(() => {
    if (canRestartToApply(stateRef.current.updateProgress)) restartToApplyUpdate();
    else void runUpdateCheck(true);
  }, [restartToApplyUpdate, runUpdateCheck, stateRef]);

  useEffect(() => {
    if (!enabled || isDetachedWindow) return;
    void runUpdateCheck(false);
    const interval = setInterval(() => { void runUpdateCheck(false); }, UPDATE_CHECK_INTERVAL_MS);
    return () => { clearInterval(interval); };
  }, [enabled, isDetachedWindow, runUpdateCheck]);

  // A channel switch checks again at once and says what it found: nightly
  // starts on today's build, stable says when this nightly build stays. An
  // update already downloading or waiting for a restart is kept.
  const checkedChannelRef = useRef(updateChannel);
  useEffect(() => {
    if (!enabled || isDetachedWindow || checkedChannelRef.current === updateChannel) return;
    checkedChannelRef.current = updateChannel;
    if (updateInFlight(stateRef.current.updateProgress)) return;
    // What the other channel offered, or how its download failed, is not this one's answer.
    if (stateRef.current.updateProgress) dispatch({ type: "SET_UPDATE_PROGRESS", progress: null });
    dispatch({ type: "SET_UPDATE_AVAILABLE", release: null });
    void runUpdateCheck(true);
  }, [dispatch, enabled, isDetachedWindow, runUpdateCheck, stateRef, updateChannel]);

  // First launch on a new version: show that release's notes, then remember the version.
  useEffect(() => {
    if (!enabled || isDetachedWindow) return;
    const config = stateRef.current.config;
    if (config.lastLaunchedVersion === VERSION) return;
    const isUpgrade = !!config.lastLaunchedVersion;
    const nextConfig = { ...config, lastLaunchedVersion: VERSION };
    dispatch({ type: "SET_CONFIG", config: nextConfig });
    void saveConfigImmediately(nextConfig).catch(() => {});
    // Nightly builds come daily and the changelog lists stable releases only.
    if (!isUpgrade || isPrereleaseVersion(VERSION)) return;
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
    restartToApplyUpdate,
    runUpdateCheck,
    runUpdateCommand,
    startUpdate,
  };
}
