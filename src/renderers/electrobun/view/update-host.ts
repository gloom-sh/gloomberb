import {
  setUpdateHost,
  type ReleaseInfo,
  type UpdateCheckResult,
  type UpdateProgress,
} from "../../../updater";
import { backendRequest, onBackendMessage } from "./backend-rpc";

/**
 * Starts a backend update request and follows its `update.progress` messages
 * until one ends the flow: `ready` ends a download, and `done` or `error` end
 * either flow. A request that itself fails is reported as an error.
 */
function followUpdateFlow(
  start: () => Promise<unknown>,
  onProgress: (progress: UpdateProgress) => void,
  endsFlow: (progress: UpdateProgress) => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const unsubscribe = onBackendMessage("update.progress", ({ progress }) => {
      onProgress(progress);
      if (endsFlow(progress)) {
        settled = true;
        unsubscribe();
        resolve();
      }
    });

    start().catch((error) => {
      if (settled) return;
      unsubscribe();
      onProgress({
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      resolve();
    });
  });
}

export function installElectrobunUpdateHost(): void {
  setUpdateHost({
    checkForUpdateDetailed(currentVersion: string): Promise<UpdateCheckResult> {
      return backendRequest("update.check", { currentVersion });
    },
    performUpdate(release: ReleaseInfo, onProgress: (progress: UpdateProgress) => void): Promise<void> {
      return followUpdateFlow(
        () => backendRequest("update.start", { release }),
        onProgress,
        (progress) => progress.phase === "ready" || progress.phase === "done" || progress.phase === "error",
      );
    },
    applyUpdate(onProgress: (progress: UpdateProgress) => void): Promise<void> {
      return followUpdateFlow(
        () => backendRequest("update.apply"),
        onProgress,
        (progress) => progress.phase === "done" || progress.phase === "error",
      );
    },
  });
}
