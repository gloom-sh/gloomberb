import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { logFailure } from "../utils/log-failure";

type RemoveFolder = (
  path: string,
  options: { recursive: true; force: true; maxRetries: number; retryDelay: number },
) => Promise<void>;

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
  remove: RemoveFolder = rm,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await use(dir);
  } finally {
    await remove(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch(logFailure("cli.screenshot", "Could not remove a capture's temporary folder"));
  }
}
