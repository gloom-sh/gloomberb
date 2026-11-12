function setCapture(renderer: unknown, renderable: unknown): void {
  const hostCapture = (renderer as { captureMouseRenderable?: (target: unknown) => void }).captureMouseRenderable;
  if (typeof hostCapture === "function") {
    hostCapture.call(renderer, renderable);
    return;
  }
  const capture = (renderer as { setCapturedRenderable?: (target: unknown) => void }).setCapturedRenderable;
  if (typeof capture === "function") {
    capture.call(renderer, renderable);
  }
}

export function capturePointerDrag(renderer: unknown, renderable: unknown): void {
  if (!renderable) return;
  setCapture(renderer, renderable);
}

/** Ends a capture whose release never came (the button let go outside the window), so the next press goes where it lands. */
export function releasePointerDrag(renderer: unknown): void {
  setCapture(renderer, undefined);
}
