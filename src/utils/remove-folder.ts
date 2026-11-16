import { rm } from "fs/promises";

type RemoveFolder = (path: string, options: { recursive: true; force: true }) => Promise<void>;

export interface RemoveFolderOptions {
  /** How long to keep trying while the folder stays locked. */
  budgetMs?: number;
  /** The wait before the second try; it doubles each time, up to half a second. */
  firstDelayMs?: number;
  remove?: RemoveFolder;
}

/**
 * Removes a folder, trying again while something still holds a file in it.
 * Windows keeps a folder locked for a moment after the program that used it
 * has gone: a browser's helper processes finishing, a virus scan of what was
 * just written. Bun's `rm` takes `maxRetries` and `retryDelay` and ignores
 * both (1.3.14), so the first EBUSY is final unless it is retried here.
 *
 * Never throws. Resolves null once the folder is gone, or the last error when
 * it is still locked after `budgetMs`.
 */
export async function removeFolder(path: string, options: RemoveFolderOptions = {}): Promise<unknown> {
  const { budgetMs = 3_000, firstDelayMs = 50, remove = rm } = options;
  const deadline = Date.now() + budgetMs;
  let delayMs = firstDelayMs;
  for (;;) {
    try {
      await remove(path, { recursive: true, force: true });
      return null;
    } catch (error) {
      if (Date.now() + delayMs > deadline) return error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 500);
  }
}
