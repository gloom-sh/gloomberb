import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { logFailure } from "../utils/log-failure";
import { removeFolder, type RemoveFolderOptions } from "../utils/remove-folder";

/**
 * Hands `use` a fresh folder under the system temp folder and removes it
 * afterwards. Removal is best effort: on Windows Chrome's helper processes can
 * hold files in its profile for a moment after the browser exits, so the
 * removal retries and, if the folder is still locked, leaves it behind rather
 * than replacing what `use` returned (or threw) with the lock error.
 */
export async function withShotTempDir<T>(
  prefix: string,
  use: (dir: string) => Promise<T>,
  removal: RemoveFolderOptions = {},
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await use(dir);
  } finally {
    if (await removeFolder(dir, removal) !== null) logFailure("cli.screenshot", "Could not remove a capture's temporary folder")(null);
  }
}
