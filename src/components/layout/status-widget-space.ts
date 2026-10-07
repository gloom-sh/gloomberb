import { useEffect, useSyncExternalStore } from "react";

/**
 * Space in the status bar for the `status:widget` slot. The bar holds back a
 * fixed number of columns for its widgets; a widget that needs more claims
 * the extra here, so the version chip and the desktop link give way to it,
 * and reads how many columns the widgets have once they have, so it can
 * render nothing rather than run into its neighbours.
 */
/** Held back for the widgets whether or not they claim more. */
export const STATUS_WIDGET_COLUMNS = 20;

const claims = new Map<string, number>();
let room = Number.POSITIVE_INFINITY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function claimedColumns(): number {
  let total = 0;
  for (const columns of claims.values()) total += columns;
  return total;
}

/** Extra columns the widgets claim, for the status bar's own layout. */
export function useClaimedStatusWidgetColumns(): number {
  return useSyncExternalStore(subscribe, claimedColumns, claimedColumns);
}

/**
 * Publishes the columns the widgets can use: right of the layout controls,
 * less Feedback, before the version chip and the desktop link. Infinite while
 * no status bar is mounted, as in isolated renders.
 */
export function usePublishStatusWidgetRoom(columns: number): void {
  useEffect(() => {
    if (room === columns) return;
    room = columns;
    emit();
  }, [columns]);
  useEffect(() => () => {
    room = Number.POSITIVE_INFINITY;
    emit();
  }, []);
}

/** The columns the widgets can use, as the status bar last published them. */
export function useStatusWidgetRoom(): number {
  return useSyncExternalStore(subscribe, () => room, () => room);
}

/** Claims extra columns for a widget while it is mounted; zero claims nothing. */
export function useStatusWidgetClaim(id: string, columns: number): void {
  useEffect(() => {
    if (columns <= 0) return;
    claims.set(id, columns);
    emit();
    return () => {
      claims.delete(id);
      emit();
    };
  }, [columns, id]);
}
