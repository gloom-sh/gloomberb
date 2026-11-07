import { fillRect, parseHex } from "../native/raster/primitives";
import { clamp } from "../../../utils/math";
import type { CompositeEventGuide } from "./types";

const GUIDE_OPACITY = 0.55;
const DOT_PIXELS = 3;
const GAP_PIXELS = 3;

/**
 * Dated events' guides in a panel's bitmap, painted before the marks so a bar
 * on the event's day still reads across its own guide: one pixel wide on the
 * bar's centre, dotted for an event whose day is not known yet.
 */
export function paintEventGuides(
  data: Uint8Array,
  width: number,
  height: number,
  guides: readonly CompositeEventGuide[],
  color: string,
): void {
  const tint = parseHex(color);
  const maxX = Math.max(width - 1, 0);
  for (const guide of guides) {
    const x = Math.round(clamp(guide.xRatio, 0, 1) * maxX);
    if (!guide.dotted) {
      fillRect(data, width, height, x, 0, x, height - 1, tint, GUIDE_OPACITY);
      continue;
    }
    for (let y = 0; y < height; y += DOT_PIXELS + GAP_PIXELS) {
      fillRect(data, width, height, x, y, x, Math.min(y + DOT_PIXELS - 1, height - 1), tint, GUIDE_OPACITY);
    }
  }
}

/**
 * The text plot's guides, in blank and grid cells only, so the marks on the
 * event's day are not covered: `│`, or `┊` for an event whose day is not known yet.
 */
export function writeEventGuidesText(rows: string[][], width: number, guides: readonly CompositeEventGuide[]): void {
  for (const guide of guides) {
    const x = clamp(Math.round(clamp(guide.xRatio, 0, 1) * Math.max(width - 1, 0)), 0, Math.max(width - 1, 0));
    for (const row of rows) {
      if (row[x] === " " || row[x] === "·") row[x] = guide.dotted ? "┊" : "│";
    }
  }
}
