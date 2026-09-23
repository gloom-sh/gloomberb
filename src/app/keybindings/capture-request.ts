/**
 * A request handed to Help > Shortcuts. `command` binds a key to command bar
 * text: the bar cannot capture a key itself, since the moment it opens it owns
 * the keyboard, and the capture has to outlive the bar closing. `review` opens
 * the table on the first binding with a problem, for the startup notice.
 */
export type KeybindingCaptureRequest =
  | { kind: "command"; query: string }
  | { kind: "review" };

let pending: KeybindingCaptureRequest | null = null;
const listeners = new Set<() => void>();

export function requestKeybindingCapture(request: KeybindingCaptureRequest): void {
  pending = request;
  for (const listener of listeners) listener();
}

/** Whether a request is waiting, for a pane deciding which tab to open on. */
export function hasKeybindingCaptureRequest(): boolean {
  return pending !== null;
}

/** Returns and clears the pending request, so it is honoured exactly once. */
export function takeKeybindingCaptureRequest(): KeybindingCaptureRequest | null {
  const request = pending;
  pending = null;
  return request;
}

export function subscribeKeybindingCapture(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
