import type { CSSProperties } from "react";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../../theme/font-scale";

/**
 * Desktop: draws a box laid out at the shell's corner at cell (x, y) with a
 * transform, so placing it somewhere else never lays anything out.
 */
export function placeStyle(x: number, y: number): CSSProperties {
  return { transform: `translate3d(${x * WEB_CELL_WIDTH}px, ${y * WEB_CELL_HEIGHT}px, 0)` };
}
