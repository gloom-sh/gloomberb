import { readdir } from "fs/promises";
import { dirname, join } from "path";
import { logFailure } from "../utils/log-failure";
import { restrictDir, restrictFile } from "../utils/private-files";

/** The data folder's files that hold the Cloud session and cache, or logs of what the user did. */
const PRIVATE_DATA_FILES = [
  ".gloomberb-cache.db",
  ".gloomberb-cache.db-wal",
  ".gloomberb-cache.db-shm",
  "stall-log.txt",
  "stall-reports.json",
  "crash-reports.json",
  "desktop-view-ids.json",
];
/** `remote-control.json` and one per app (`remote-control.tui.json`): each holds the remote-control token. */
const REMOTE_ENDPOINT_FILE = /^remote-control(?:\.[\w-]+)?\.json$/;

/**
 * Tightens a profile made before its folders and files were created private,
 * or under a umask that let others read them: the data folder and each
 * config.json's folder open to the user alone, config.json (broker
 * credentials) and the files above readable by the user alone. A step that
 * fails (a folder another account owns, a disk without POSIX modes) is logged
 * and the others still run; startup goes on either way. Nothing to do on
 * Windows (see private-files.ts).
 */
export async function tightenProfilePermissions(dataDir: string, configFiles: readonly string[]): Promise<void> {
  if (process.platform === "win32") return;
  const steps: Array<() => Promise<void>> = [
    ...[...new Set([dataDir, ...configFiles.map((file) => dirname(file))])].map((dir) => () => restrictDir(dir)),
    ...[...new Set(configFiles)].map((file) => () => restrictFile(file)),
    ...PRIVATE_DATA_FILES.map((name) => () => restrictFile(join(dataDir, name))),
    async () => {
      for (const name of await readdir(dataDir)) {
        if (REMOTE_ENDPOINT_FILE.test(name)) await restrictFile(join(dataDir, name));
      }
    },
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      logFailure("data.profile-permissions", "Restricting a profile file to its user failed")(error);
    }
  }
}
