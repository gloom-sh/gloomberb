import { useSyncExternalStore } from "react";
import { createListenerSet } from "../utils/listeners";

/**
 * Panes placed before their ticker is found. Opening a ticker the app does
 * not hold yet looks it up over the network (search, then its quote), which
 * can take seconds; the pane shows at once and the lookup settles it. Until
 * then the pane has a symbol and no ticker record, and says it is loading
 * rather than that no ticker is selected.
 */
const opening = new Set<string>();
const listeners = createListenerSet();

/** Marks a pane as opening; the returned stop clears it, once. */
export function markTickerPaneOpening(instanceId: string): () => void {
  opening.add(instanceId);
  listeners.notify();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (opening.delete(instanceId)) listeners.notify();
  };
}

export function isTickerPaneOpening(instanceId: string | null | undefined): boolean {
  return !!instanceId && opening.has(instanceId);
}

/** Whether the pane's ticker is still being looked up. */
export function useTickerPaneOpening(instanceId: string | null | undefined): boolean {
  return useSyncExternalStore(listeners.subscribe, () => isTickerPaneOpening(instanceId), () => false);
}

export function resetOpeningTickerPanesForTests(): void {
  opening.clear();
}
