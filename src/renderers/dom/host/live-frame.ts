import type { CSSProperties } from "react";
import type { LiveBoxFrame } from "../../../ui/host";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { commonStyle } from "./style";

function renderedValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Draws a box where a drag has it this frame by restyling its element,
 * outside React: an offset on its own compositor layer, with no layout or
 * repaint. `null` hands the properties back to what React last rendered.
 */
export function applyLiveFrame(element: HTMLElement, frame: LiveBoxFrame | null, props: Record<string, unknown>): void {
  const style = element.style;
  if (!frame) {
    const rendered: CSSProperties = { ...commonStyle(props), ...(props.style as CSSProperties | undefined) };
    style.transform = renderedValue(rendered.transform);
    style.willChange = renderedValue(rendered.willChange);
    return;
  }
  // Promoted once, before the first frame of the drag.
  if (style.willChange !== "transform") style.willChange = "transform";
  style.transform = `translate3d(${frame.dx * WEB_CELL_WIDTH}px, ${frame.dy * WEB_CELL_HEIGHT}px, 0)`;
}
