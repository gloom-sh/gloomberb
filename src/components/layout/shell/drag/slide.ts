import type { CSSProperties } from "react";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../../theme/font-scale";

/**
 * Desktop: moves a drawn element by a cell offset on the compositor. Changing
 * only a transform on its own layer skips layout and repaint, which is what
 * keeps a drag at the display's frame rate over heavy panes.
 */
export function slideStyle(dx: number, dy: number): CSSProperties {
  return {
    transform: `translate3d(${dx * WEB_CELL_WIDTH}px, ${dy * WEB_CELL_HEIGHT}px, 0)`,
    willChange: "transform",
  };
}
