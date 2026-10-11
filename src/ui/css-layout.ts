/**
 * Spike, off by default (GLO-544): the desktop and web shell let the browser
 * lay out the docked panes instead of computing their rects in JS. The dock
 * tree renders as nested flex boxes whose split ratios are flex bases, so a
 * divider drag writes one flex basis outside React and the browser lays out
 * everything under it; pane content learns its size from a ResizeObserver
 * (`useMeasuredCells`) instead of from the layout.
 *
 * On only with `?layout=css` in the page URL, or `localStorage["gloom.layout"]`
 * set to "css" (the desktop app, which has no URL to edit). `measure=` picks
 * when content laid out on the cell grid renders at its measured size while
 * the pointer resizes it:
 *
 * - `catch-up` (the default): at most every 100 ms, as main's catch-up does;
 * - `release`: once, when the pointer lets go;
 * - `frame`: on every frame the browser lays it out at a new size.
 *
 * The terminal never reads this: it has no browser to lay anything out.
 */
type CssLayoutMeasure = "catch-up" | "release" | "frame";

interface CssLayoutMode {
  measure: CssLayoutMeasure;
}

const MEASURES: readonly CssLayoutMeasure[] = ["catch-up", "release", "frame"];

function readMode(): CssLayoutMode | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  let params: URLSearchParams | null = null;
  try {
    params = new URLSearchParams(window.location?.search ?? "");
  } catch {
    params = null;
  }
  let stored: string | null = null;
  try {
    stored = window.localStorage?.getItem("gloom.layout") ?? null;
  } catch {
    stored = null;
  }
  if (params?.get("layout") !== "css" && stored !== "css") return null;
  const measure = params?.get("measure") as CssLayoutMeasure | null;
  return { measure: measure && MEASURES.includes(measure) ? measure : "catch-up" };
}

const mode = readMode();

/** The spike's mode when it is switched on for this page, otherwise null. */
export function cssLayoutMode(): CssLayoutMode | null {
  return mode;
}
