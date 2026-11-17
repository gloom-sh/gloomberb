interface ProWelcomeKeyHandlers {
  open(): void;
  dismiss(): void;
}

/** What the notification keys do while the row shows; null otherwise. */
let keyHandlers: ProWelcomeKeyHandlers | null = null;

/** Hands the notification keys to the row while it shows; returns the release. */
export function bindProWelcomeKeys(handlers: ProWelcomeKeyHandlers): () => void {
  keyHandlers = handlers;
  return () => {
    if (keyHandlers === handlers) keyHandlers = null;
  };
}

/**
 * Runs the row's open (its first function) or dismiss for the notification
 * keys. False when the row is not showing, so the key goes on to whatever
 * else wants it.
 */
export function pressProWelcomeKey(kind: "open" | "dismiss"): boolean {
  if (!keyHandlers) return false;
  if (kind === "open") keyHandlers.open();
  else keyHandlers.dismiss();
  return true;
}
