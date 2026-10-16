/**
 * Share makes a pane's link, and Report a Bug pictures a pane and opens a
 * dialog on it. One of them runs at a time per window, from the start until
 * the link is copied, the dialog closes or the post lands, so starting either
 * while the other runs (Report a Bug's capture frames included, before its
 * dialog mounts) does nothing.
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
