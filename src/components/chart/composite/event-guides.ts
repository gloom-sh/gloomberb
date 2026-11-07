import { fillRect, parseHex } from "../native/raster/primitives";
import { clamp } from "../../../utils/math";
import type { CompositeEventGuide } from "./types";

const GUIDE_OPACITY = 0.55;
/** A period's span, as faint as extended hours' shading. */
const SPAN_OPACITY = 0.08;
const DOT_PIXELS = 3;
const GAP_PIXELS = 3;
/** The text plot's guide, and a dotted one: glyphs no candle, cursor or session break draws. */
const EVENT_GUIDE_CHAR = "╎";
const DOTTED_EVENT_GUIDE_CHAR = "┆";

/** The guide's edges inside the plot: its own x, or a period's first and last. */
function edges(guide: CompositeEventGuide): number[] {
  const ratios = guide.endXRatio === undefined ? [guide.xRatio] : [guide.xRatio, guide.endXRatio];
  return ratios.filter((ratio) => ratio >= 0 && ratio <= 1);
}

/**
 * Dated events' guides in a panel's bitmap, painted before the marks so a bar
 * on the event's day still reads across its own guide: one pixel wide on the
 * bar's centre, dotted for an event whose day is not known yet. A period is
 * shaded from its first day to its last, a guide at each end.
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
    if (guide.endXRatio !== undefined) {
      const from = Math.round(clamp(guide.xRatio, 0, 1) * maxX), to = Math.round(clamp(guide.endXRatio, 0, 1) * maxX);
      if (to > from) fillRect(data, width, height, from, 0, to, height - 1, tint, SPAN_OPACITY);
    }
    for (const ratio of edges(guide)) {
      const x = Math.round(ratio * maxX);
      if (!guide.dotted) {
        fillRect(data, width, height, x, 0, x, height - 1, tint, GUIDE_OPACITY);
        continue;
      }
      for (let y = 0; y < height; y += DOT_PIXELS + GAP_PIXELS) {
        fillRect(data, width, height, x, y, x, Math.min(y + DOT_PIXELS - 1, height - 1), tint, GUIDE_OPACITY);
      }
    }
  }
}

const open = (cell: string | undefined) => cell === undefined || cell === " " || cell === "·";

/**
 * The text plot's guides, `╎`, or `┆` for an event whose day is not known
 * yet (at each end of its period), in blank and grid cells only, and never
 * in the cell just above or below a mark, so the day's candle keeps its high
 * and low readable.
 */
export function writeEventGuidesText(rows: string[][], width: number, guides: readonly CompositeEventGuide[]): void {
  const maxX = Math.max(width - 1, 0);
  const writes: { row: number; x: number; char: string }[] = [];
  for (const guide of guides) {
    const char = guide.dotted ? DOTTED_EVENT_GUIDE_CHAR : EVENT_GUIDE_CHAR;
    for (const ratio of edges(guide)) {
      const x = clamp(Math.round(ratio * maxX), 0, maxX);
      rows.forEach((row, index) => {
        if (open(row[x]) && open(rows[index - 1]?.[x]) && open(rows[index + 1]?.[x])) writes.push({ row: index, x, char });
      });
    }
  }
  for (const { row, x, char } of writes) rows[row]![x] = char;
}
