import { useEffect } from "react";
import type { CloudSearchHit } from "../../../api-client";

type FocusListener = (hit: CloudSearchHit) => void;

const pendingByPaneId = new Map<string, CloudSearchHit>();
const listenersByPaneId = new Map<string, Set<FocusListener>>();

/**
 * Hands a hit to the pane that is about to show it. Opening a document from the
 * command bar creates the pane and names the document in one gesture, but the
 * two cannot be one call: pane creation is async and the hit is far too big to
 * push through pane settings, which are persisted and shared. So the request is
 * parked here until the pane mounts, and delivered directly if it already has.
 */
export function requestDocumentFocus(paneId: string, hit: CloudSearchHit): void {
  const listeners = listenersByPaneId.get(paneId);
  if (listeners && listeners.size > 0) {
    for (const listener of listeners) listener(hit);
    return;
  }
  pendingByPaneId.set(paneId, hit);
}

export function useDocumentFocusRequest(paneId: string, onFocus: FocusListener): void {
  useEffect(() => {
    const listeners = listenersByPaneId.get(paneId) ?? new Set<FocusListener>();
    listeners.add(onFocus);
    listenersByPaneId.set(paneId, listeners);

    const pending = pendingByPaneId.get(paneId);
    if (pending) {
      pendingByPaneId.delete(paneId);
      onFocus(pending);
    }

    return () => {
      listeners.delete(onFocus);
      if (listeners.size === 0) listenersByPaneId.delete(paneId);
    };
  }, [onFocus, paneId]);
}

export function resetDocumentFocusRequests(): void {
  pendingByPaneId.clear();
  listenersByPaneId.clear();
}
