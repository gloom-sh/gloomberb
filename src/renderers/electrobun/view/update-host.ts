import {
  setUpdateHost,
  type ReleaseInfo,
  type UpdateCheckResult,
  type UpdateProgress,
} from "../../../updater";
import { backendRequest, onUpdateProgress } from "./backend-rpc";

export function installElectrobunUpdateHost(): void {
  setUpdateHost({
    checkForUpdateDetailed(currentVersion: string): Promise<UpdateCheckResult> {
      return backendRequest("update.check", { currentVersion });
    },
    performUpdate(release: ReleaseInfo, onProgress: (progress: UpdateProgress) => void): Promise<void> {
      return new Promise((resolve) => {
        let settled = false;
        const unsubscribe = onUpdateProgress(({ progress }) => {
          onProgress(progress);
          if (progress.phase === "done" || progress.phase === "error") {
            settled = true;
            unsubscribe();
            resolve();
          }
        });

        backendRequest("update.start", { release }).catch((error) => {
          if (settled) return;
          unsubscribe();
          onProgress({
            phase: "error",
            error: error instanceof Error ? error.message : String(error),
          });
          resolve();
        });
      });
    },
  });
}
