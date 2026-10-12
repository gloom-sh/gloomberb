let shield: HTMLElement | null = null;

/**
 * While a press drags, one transparent sheet covers the window: it keeps the
 * grabbing cursor wherever the pointer goes and takes the hover, so nothing
 * under the pointer restyles while a pane, divider or chart moves across it.
 * It is a single element on purpose: a class on body matched by descendant
 * rules restyled every element with a role (thousands on a busy layout) in
 * the frame the drag began, and again when it ended.
 *
 * A press on a resize edge (a pane's corner, a split) keeps its resize cursor
 * for the drag instead, as a window edge does.
 */
export function showDragShield(pressed?: Element | null): void {
  document.body.classList.add("gloom-dragging");
  if (!shield?.isConnected) {
    shield = document.createElement("div");
    shield.setAttribute("data-gloom-role", "drag-shield");
    shield.setAttribute("aria-hidden", "true");
    document.body.appendChild(shield);
  }
  shield.style.cursor = resizeCursor(pressed);
}

function resizeCursor(element: Element | null | undefined): string {
  if (!element || typeof getComputedStyle !== "function") return "";
  const cursor = getComputedStyle(element).cursor;
  return cursor.endsWith("-resize") ? cursor : "";
}

export function hideDragShield(): void {
  document.body.classList.remove("gloom-dragging");
  shield?.remove();
  shield = null;
}
