import type { CSSProperties } from "react";
import type { LiveBoxFrame } from "../../../ui/host";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { commonStyle } from "./style";

/**
 * Blink lays the whole page out into compositor layers again whenever a
 * style transform changes, even on a `will-change` layer: 4 to 9 ms a frame
 * on a ten-pane desktop. The same transform held by a running animation's
 * keyframes only updates the compositor (under 1 ms), at the same latency.
 * WebKit has no such pass, and there an animation per frame costs more than
 * the plain style, so it keeps the style.
 */
const ANIMATION_CARRIES_SLIDE = typeof navigator !== "undefined"
  && /Chrome\//.test(navigator.userAgent)
  && typeof Element !== "undefined"
  && typeof Element.prototype.animate === "function";

const slides = new WeakMap<HTMLElement, Animation>();

/** A style value as React writes it: a bare number is pixels. */
function renderedValue(value: unknown): string {
  if (typeof value === "number") return `${value}px`;
  return typeof value === "string" ? value : "";
}

function slide(element: HTMLElement, transform: string): void {
  if (!ANIMATION_CARRIES_SLIDE) {
    element.style.transform = transform;
    return;
  }
  const keyframes = [{ transform }, { transform }];
  const running = slides.get(element);
  if (running) (running.effect as KeyframeEffect).setKeyframes(keyframes);
  else slides.set(element, element.animate(keyframes, { duration: 1e9, fill: "both" }));
}

/**
 * Draws a box where a drag has it this frame by restyling its element,
 * outside React: an offset on its own compositor layer, with no layout or
 * repaint, and a size, which lays out only the box's subtree. `null` hands
 * the properties back to what React last rendered.
 */
export function applyLiveFrame(element: HTMLElement, frame: LiveBoxFrame | null, props: Record<string, unknown>): void {
  const style = element.style;
  if (!frame) {
    const rendered: CSSProperties = { ...commonStyle(props), ...(props.style as CSSProperties | undefined) };
    slides.get(element)?.cancel();
    slides.delete(element);
    style.transform = renderedValue(rendered.transform);
    style.willChange = renderedValue(rendered.willChange);
    style.width = renderedValue(rendered.width);
    style.height = renderedValue(rendered.height);
    return;
  }
  if (frame.width !== undefined) style.width = `${frame.width * WEB_CELL_WIDTH}px`;
  if (frame.height !== undefined) style.height = `${frame.height * WEB_CELL_HEIGHT}px`;
  if (frame.dx === undefined && frame.dy === undefined) return;
  // Promoted once, before the first frame of the drag.
  if (style.willChange !== "transform") style.willChange = "transform";
  slide(element, `translate3d(${(frame.dx ?? 0) * WEB_CELL_WIDTH}px, ${(frame.dy ?? 0) * WEB_CELL_HEIGHT}px, 0)`);
}
