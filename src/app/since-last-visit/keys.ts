interface SinceLastVisitKeyHandlers {
  open(): void;
  dismiss(): void;
}

/** What the notification keys do while the strip shows; null otherwise. */
let keyHandlers: SinceLastVisitKeyHandlers | null = null;

/** Hands the notification keys to the strip while it shows; returns the release. */
export function bindSinceLastVisitKeys(handlers: SinceLastVisitKeyHandlers): () => void {
  keyHandlers = handlers;
  return () => {
    if (keyHandlers === handlers) keyHandlers = null;
  };
}

/**
 * Runs the strip's open (its biggest move) or hide for the notification keys.
 * False when the strip is not showing, so the key goes on to whatever else wants it.
 */
export function pressSinceLastVisitKey(kind: "open" | "dismiss"): boolean {
  if (!keyHandlers) return false;
  if (kind === "open") keyHandlers.open();
  else keyHandlers.dismiss();
  return true;
}
