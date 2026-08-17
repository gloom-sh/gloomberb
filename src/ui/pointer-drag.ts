export function capturePointerDrag(renderer: unknown, renderable: unknown): void {
  if (!renderable) return;
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
