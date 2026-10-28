import { ANONYMOUS_ID_STORAGE_KEY, ATTRIBUTION_STORAGE_KEY } from "../../../api-client/research-activity";
import { SYNC_CLIENT_ID_STORAGE_KEY } from "../../../sync/controller";
import { logFailure } from "../../../utils/log-failure";
import type { DesktopViewIds } from "../shared/protocol";

/**
 * What the desktop view keeps only in its WebView storage: the id Cloud sync
 * knows this device by, and the visitor id and first touch a gloom.sh link
 * handed over. macOS and Windows keep that storage under the app's bundle
 * identifier, so a build under another identifier would start without them.
 * The Bun process keeps a copy in the data folder (bun/desktop/view-ids.ts),
 * and a view whose storage lacks one takes it back from there.
 */
const VIEW_ID_KEYS = [SYNC_CLIENT_ID_STORAGE_KEY, ANONYMOUS_ID_STORAGE_KEY, ATTRIBUTION_STORAGE_KEY] as const;

interface ViewIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The view's WebView storage, or null where it is refused. */
export function viewIdStorage(): ViewIdStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Intentional ignore: without storage there is nothing to restore or keep.
    return null;
  }
}

function readViewIds(storage: ViewIdStorage): DesktopViewIds {
  const ids: DesktopViewIds = {};
  for (const key of VIEW_ID_KEYS) {
    const value = storage.getItem(key);
    if (value) ids[key] = value;
  }
  return ids;
}

function sameIds(left: DesktopViewIds, right: DesktopViewIds): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/** Puts the ids kept on disk into `storage` where it has none. One it has is never replaced. */
export function restoreViewIds(storage: ViewIdStorage, kept: DesktopViewIds | undefined): void {
  try {
    for (const key of VIEW_ID_KEYS) {
      const value = kept?.[key];
      if (value && !storage.getItem(key)) storage.setItem(key, value);
    }
  } catch (error) {
    logFailure("desktop-view-ids", "Could not restore the view's ids")(error);
  }
}

/**
 * A function that sends the ids in `storage` to be kept on disk when they
 * differ from the copy there (`kept`, from `init`). It reads three keys, so it
 * can run whenever one of them may have been written. A save that fails is
 * tried again at the next call.
 */
export function createViewIdMirror(
  storage: ViewIdStorage,
  kept: DesktopViewIds | undefined,
  save: (ids: DesktopViewIds) => Promise<unknown>,
): () => void {
  let onDisk: DesktopViewIds = { ...kept };
  return () => {
    let ids: DesktopViewIds;
    try {
      ids = readViewIds(storage);
    } catch (error) {
      logFailure("desktop-view-ids", "Could not read the view's ids")(error);
      return;
    }
    if (sameIds(ids, onDisk)) return;
    const previous = onDisk;
    onDisk = ids;
    save(ids).catch((error: unknown) => {
      if (onDisk === ids) onDisk = previous;
      logFailure("desktop-view-ids", "Could not send the view's ids to be kept")(error);
    });
  };
}
