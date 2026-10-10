import type { ResolvedSeries, SeriesStyle } from "../../../time-series/types";

/**
 * What tells one line from another besides its colour, so a chart still reads
 * in greyscale and for colour-blind eyes. Each renderer draws its own form of
 * the same cue: the bitmap (kitty, desktop, web, `shot`) a dash pattern or a
 * heavier stroke, the cell fallback a different mark along the line, and the
 * legend a sample of whichever the plot shows next to the series name.
 */
export interface SeriesLineCue {
  id: "solid" | "dashed" | "dotted" | "dash-dot" | "heavy";
  /** On and off lengths along the line in bitmap pixels; empty is a solid line. */
  dash: readonly number[];
  /** Stroke width in bitmap pixels. */
  thickness: number;
  /** The mark the cell renderer draws the line with. */
  glyph: string;
  /** Two terminal cells of the line, for the legend beside a bitmap plot. */
  sample: string;
}

/** The plain line every single-line chart keeps. */
export const SOLID_LINE_THICKNESS = 1.5;

/**
 * Dash lengths allow for the stroke's round ends, which eat about its width
 * out of every gap: a 6 on, 5 off pattern reads as even dashes.
 */
const LINE_CUES: readonly SeriesLineCue[] = [
  { id: "solid", dash: [], thickness: SOLID_LINE_THICKNESS, glyph: "•", sample: "──" },
  { id: "dashed", dash: [7, 6], thickness: SOLID_LINE_THICKNESS, glyph: "+", sample: "╌╌" },
  { id: "dotted", dash: [1, 4.5], thickness: 2, glyph: "×", sample: "┈┈" },
  { id: "dash-dot", dash: [9, 4.5, 1, 4.5], thickness: SOLID_LINE_THICKNESS, glyph: "o", sample: "─·" },
  { id: "heavy", dash: [], thickness: 3, glyph: "*", sample: "━━" },
];

const LINE_STYLES = new Set<SeriesStyle>(["line", "step", "area", "band"]);

export function isLineCueStyle(style: SeriesStyle): boolean {
  return LINE_STYLES.has(style);
}

/**
 * A cue for each line of a chart that draws two or more. Lines are counted in
 * legend order, hidden ones included, so hiding one does not restyle the
 * others; the first keeps the plain solid line. A chart with one line gets
 * none and looks as it always has.
 */
export function assignSeriesLineCues(series: readonly ResolvedSeries[]): ReadonlyMap<string, SeriesLineCue> {
  const lines = series.filter((entry) => isLineCueStyle(entry.style) && !entry.profile);
  const cues = new Map<string, SeriesLineCue>();
  if (lines.length < 2) return cues;
  for (const entry of lines) {
    if (!cues.has(entry.id)) cues.set(entry.id, LINE_CUES[cues.size % LINE_CUES.length]!);
  }
  return cues;
}

/** A repeating CSS gradient that draws the cue's dashes, for the desktop and web legend. */
export function seriesCueCssBackground(cue: SeriesLineCue, color: string): string {
  if (cue.dash.length === 0) return color;
  // Half the bitmap lengths: the legend sample is drawn in CSS pixels at its own size.
  const stops: string[] = [];
  let at = 0;
  cue.dash.forEach((length, index) => {
    const end = at + Math.max(1, length / 2 + (index % 2 === 0 ? 0.5 : -0.5));
    stops.push(`${index % 2 === 0 ? color : "transparent"} ${at}px ${end}px`);
    at = end;
  });
  return `repeating-linear-gradient(to right, ${stops.join(", ")})`;
}
