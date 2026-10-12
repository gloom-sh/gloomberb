import { useCallback, useSyncExternalStore } from "react";
import { getShare } from "../../../../shares/api";
import type { PaneDef } from "../../../../types/plugin";

/**
 * What a share chip shows, read from the share itself and nothing else: its
 * title and the pane it holds. The read does not count as a view of the share.
 */
export type SharePreview =
  | { status: "loading" }
  | { status: "ready"; title: string; paneId: string | null }
  | { status: "unavailable" };

const LOADING: SharePreview = { status: "loading" };
const MAX_PREVIEWS = 200;
const MAX_IN_FLIGHT = 4;
const RETRY_AFTER_MS = 60_000;

interface Entry {
  preview: SharePreview;
  /** Queued or being read. */
  pending: boolean;
  /** Set when the read failed (not a missing share): a chip drawn a minute later reads it again. */
  failedAt?: number;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();
const queue: string[] = [];
let inFlight = 0;

function entryFor(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    entry = { preview: LOADING, pending: false, listeners: new Set() };
    entries.set(id, entry);
    // Oldest first out, never one a chip on screen is listening to or one being read.
    for (const [key, old] of entries) {
      if (entries.size <= MAX_PREVIEWS) break;
      if (old.listeners.size === 0 && !old.pending) entries.delete(key);
    }
  }
  return entry;
}

function settle(id: string, preview: SharePreview, failed: boolean): void {
  const entry = entryFor(id);
  entry.preview = preview;
  entry.pending = false;
  entry.failedAt = failed ? Date.now() : undefined;
  for (const listener of entry.listeners) listener();
}

function pump(): void {
  while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
    const id = queue.shift()!;
    inFlight += 1;
    void getShare(id, fetch, { trackView: false })
      .then((share) => {
        if (!share) {
          settle(id, { status: "unavailable" }, false);
          return;
        }
        const paneId = share.kind === "pane" && share.data.version === 2
          ? share.data.layout.layout.instances[0]?.paneId ?? null
          : null;
        settle(id, { status: "ready", title: share.data.title, paneId }, false);
      })
      .catch(() => settle(id, LOADING, true))
      .finally(() => {
        inFlight -= 1;
        pump();
      });
  }
}

function request(id: string): void {
  const entry = entryFor(id);
  if (entry.preview.status !== "loading" || entry.pending) return;
  if (entry.failedAt !== undefined && Date.now() - entry.failedAt < RETRY_AFTER_MS) return;
  entry.pending = true;
  queue.push(id);
  pump();
}

/** What chips show for a share now, for code outside React (the Open list). */
export function peekSharePreview(id: string): SharePreview {
  return entries.get(id)?.preview ?? LOADING;
}

/** The share's title and pane, loaded once per session for every chip that shows it; "" reads nothing. */
export function useSharePreview(id: string): SharePreview {
  const subscribe = useCallback((listener: () => void) => {
    if (!id) return () => {};
    const entry = entryFor(id);
    entry.listeners.add(listener);
    request(id);
    return () => {
      entry.listeners.delete(listener);
    };
  }, [id]);
  const read = useCallback(() => entries.get(id)?.preview ?? LOADING, [id]);
  return useSyncExternalStore(subscribe, read, read);
}

type PaneDefLookup = (paneId: string) => Pick<PaneDef, "name" | "icon"> | undefined;
let paneDefs: PaneDefLookup | null = null;

/** The chat plugin hands over the app's panes, so a chip can say which pane it opens. */
export function attachChatPaneLinkPanes(lookup: PaneDefLookup): () => void {
  paneDefs = lookup;
  return () => {
    if (paneDefs === lookup) paneDefs = null;
  };
}

export function chatPaneLinkPane(paneId: string | null | undefined): Pick<PaneDef, "name" | "icon"> | null {
  return paneId ? paneDefs?.(paneId) ?? null : null;
}
