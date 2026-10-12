function postWindowMove(id: "startWindowMove" | "stopWindowMove"): void {
  window.__electrobunInternalBridge?.postMessage(JSON.stringify([
    JSON.stringify({ type: "message", id, payload: { id: window.__electrobunWindowId } }),
  ]));
}

let endWindowMove: (() => void) | null = null;

/**
 * Moves the window with the pointer until the button comes up. Electrobun
 * stops the move when its native monitor sees the release, but only if the
 * start reached it first: the start goes through the Bun process, and a quick
 * click releases before it lands, leaving the window following the bare
 * pointer until the next click. The release is sent from here too, as
 * Electrobun's own drag regions do; it always arrives after the start.
 */
export function startElectrobunWindowDrag(): void {
  // A press whose release never reached the page (it ended outside the window) is over.
  endWindowMove?.();
  postWindowMove("startWindowMove");
  const end = () => {
    window.removeEventListener("mouseup", end, true);
    if (endWindowMove === end) endWindowMove = null;
    postWindowMove("stopWindowMove");
  };
  endWindowMove = end;
  window.addEventListener("mouseup", end, true);
}
