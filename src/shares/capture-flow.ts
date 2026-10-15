/**
 * Share and Report a Bug each picture a pane and open a dialog on it. One of
 * them runs at a time per window, from the capture until its dialog closes or
 * its post lands, so starting either while the other runs (its capture
 * frames included, before its dialog mounts) does nothing.
 */
let inFlight = false;

/** Claims the window's one capture flow, with the release that ends it; null while one runs. */
export function claimCaptureFlow(): (() => void) | null {
  if (inFlight) return null;
  inFlight = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight = false;
  };
}
