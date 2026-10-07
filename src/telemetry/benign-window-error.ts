const RESIZE_OBSERVER_LOOP = /resizeobserver loop/i;

/** Chromium reports this when a resize callback changes layout in the same frame. It is a notice, not a crashed renderer. */
export function isBenignWindowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return RESIZE_OBSERVER_LOOP.test(message);
}
