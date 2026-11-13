import { useEffect } from "react";
import { useOptionalPaneInstanceId } from "./app/context";

/**
 * Panes holding something an Esc must not throw away: a draft not sent, an
 * answer still coming in. Esc, one press or two, never closes such a pane; a
 * deliberate close (Ctrl+W, the close button, the pane menu) still does.
 *
 * A pane whose draft outlives it (saved with the chat channel, a note saved
 * when editing ends) has nothing to report. Neither has a form that takes its
 * own Esc as Cancel: that Esc never reaches the close.
 */
const holders = new Map<string, Set<symbol>>();

export function paneHoldsUnsentWork(paneId: string | null | undefined): boolean {
  return !!paneId && (holders.get(paneId)?.size ?? 0) > 0;
}

/** Marks a pane as holding unsent work until the returned release is called. */
export function holdPaneUnsentWork(paneId: string): () => void {
  const token = Symbol(paneId);
  let entry = holders.get(paneId);
  if (!entry) {
    entry = new Set();
    holders.set(paneId, entry);
  }
  const held = entry;
  held.add(token);
  return () => {
    held.delete(token);
    if (held.size === 0 && holders.get(paneId) === held) holders.delete(paneId);
  };
}

/**
 * Reports that the pane holds work an Esc must not throw away while `holds`
 * is true: a composer with text in it, an answer still streaming. The pane is
 * the one in context, or `paneId` where the caller names it.
 */
export function usePaneUnsentWork(holds: boolean, paneId?: string): void {
  const contextPaneId = useOptionalPaneInstanceId();
  const target = paneId ?? contextPaneId;
  useEffect(() => {
    if (!holds || !target) return undefined;
    return holdPaneUnsentWork(target);
  }, [holds, target]);
}
