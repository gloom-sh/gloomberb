import { rename as renameFile } from "fs/promises";

/**
 * How long to wait before each new try. About a second and a half in all:
 * long enough for a scanner to finish with a small file, short enough that a
 * save that really cannot happen still fails while the user waits on it.
 */
const RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800];

/** The refusals Windows gives while another process holds either file open. */
const HELD_OPEN_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface RenameIntoPlaceOptions {
  platform?: NodeJS.Platform;
  rename?: (source: string, target: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Renames a file just written over `target`. Windows refuses the rename while
 * anything still holds either file open: a virus scanner reading the file
 * just written, the search indexer or a sync client reading the old one. That
 * passes in a moment, so a refusal there is tried again for a moment before
 * it counts, as the plugin installer does for its folders. Elsewhere such a
 * refusal is a real permission problem and fails at once.
 */
export async function renameIntoPlace(
  source: string,
  target: string,
  {
    platform = process.platform,
    rename = renameFile,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: RenameIntoPlaceOptions = {},
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const delay = RETRY_DELAYS_MS[attempt];
      if (platform !== "win32" || typeof code !== "string" || !HELD_OPEN_CODES.has(code) || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}
