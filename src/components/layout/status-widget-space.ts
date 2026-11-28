import { useEffect, useSyncExternalStore } from "react";
import { createListenerSet } from "../../utils/listeners";

/**
 * Space in the status bar for the `status:widget` slot. The bar holds back a
 * fixed number of columns for its widgets; a widget that needs more claims
 * the extra here, so the connection note gives way to it, and reads how many
 * columns the widgets have once they have, so it can render nothing rather
 * than run into its neighbours.
 */
/** Held back for the widgets whether or not they claim more. */
export const STATUS_WIDGET_COLUMNS = 20;

/**
 * Below this many columns the status bar is a narrow terminal's or a phone's,
 * as Tidy reads the same width: the layout tabs are cut to fit in the
 * terminal, and on the desktop and the web, where the tabs give way to the
 * widgets, a widget takes its short form so the tab in front shows whole.
 */
export const NARROW_STATUS_BAR_COLUMNS = 80;

const claims = new Map<string, number>();
let room = Number.POSITIVE_INFINITY;
const listeners = createListenerSet();

function claimedColumns(): number {
  let total = 0;
  for (const columns of claims.values()) total += columns;
  return total;
}

/** Extra columns the widgets claim, for the status bar's own layout. */
export function useClaimedStatusWidgetColumns(): number {
  return useSyncExternalStore(listeners.subscribe, claimedColumns, claimedColumns);
}

/**
 * Publishes the columns the widgets can use: right of the layout controls,
 * less Feedback. Infinite while no status bar is mounted, as in isolated
 * renders.
 */
export function usePublishStatusWidgetRoom(columns: number): void {
  useEffect(() => {
    if (room === columns) return;
    room = columns;
    listeners.notify();
  }, [columns]);
  useEffect(() => () => {
    room = Number.POSITIVE_INFINITY;
    listeners.notify();
  }, []);
}

/**
 * Extra columns the other widgets claim, for a widget that sizes itself to
 * what they leave rather than run into them.
 */
export function useOtherStatusWidgetClaims(id: string): number {
  const others = () => claimedColumns() - (claims.get(id) ?? 0);
  return useSyncExternalStore(listeners.subscribe, others, others);
}

/** The columns the widgets can use, as the status bar last published them. */
export function useStatusWidgetRoom(): number {
  return useSyncExternalStore(listeners.subscribe, () => room, () => room);
}

/** Claims extra columns for a widget while it is mounted; zero claims nothing. */
export function useStatusWidgetClaim(id: string, columns: number): void {
  useEffect(() => {
    if (columns <= 0) return;
    claims.set(id, columns);
    listeners.notify();
    return () => {
      claims.delete(id);
      listeners.notify();
    };
  }, [columns, id]);
}
