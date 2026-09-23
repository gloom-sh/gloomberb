/**
 * Font scaling for the DOM renderer.
 *
 * Every web measurement — pane geometry, table rows, floating windows, the
 * command bar — is expressed in grid cells, so the whole app scales by resizing
 * the cell in step with the root font size rather than by restyling each pane.
 * `WEB_CELL_WIDTH` / `WEB_CELL_HEIGHT` are live bindings: importers read the
 * current value, and a re-render after `syncFontScale()` picks up the new grid.
 *
 * The terminal renderer owns no font (the emulator does), so this no-ops there.
 */

export const BASE_FONT_SIZE_PX = 12;
export const MIN_FONT_SIZE_PX = 10;
export const MAX_FONT_SIZE_PX = 20;

const BASE_CELL_WIDTH_PX = 8;
const BASE_CELL_HEIGHT_PX = 18;

export let WEB_CELL_WIDTH: number = BASE_CELL_WIDTH_PX;
export let WEB_CELL_HEIGHT: number = BASE_CELL_HEIGHT_PX;

let appliedFontSizePx = BASE_FONT_SIZE_PX;
let appliedToDocument = false;

export function clampFontSize(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : BASE_FONT_SIZE_PX;
  return Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, Math.round(numeric)));
}

function roundToHundredth(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Applies a font size to the document grid. Returns true when the grid changed,
 * so callers can force dependent measurements to refresh.
 */
export function syncFontScale(fontSizePx: unknown): boolean {
  const size = clampFontSize(fontSizePx);
  if (size === appliedFontSizePx && appliedToDocument) return false;

  const scale = size / BASE_FONT_SIZE_PX;
  appliedFontSizePx = size;
  WEB_CELL_WIDTH = roundToHundredth(BASE_CELL_WIDTH_PX * scale);
  WEB_CELL_HEIGHT = roundToHundredth(BASE_CELL_HEIGHT_PX * scale);

  const style = (globalThis as {
    document?: { body?: { style?: { setProperty: (name: string, value: string) => void } } };
  }).document?.body?.style;
  if (!style) return false;

  style.setProperty("--cell-w", `${WEB_CELL_WIDTH}px`);
  style.setProperty("--cell-h", `${WEB_CELL_HEIGHT}px`);
  style.setProperty("--chrome-h", `${chromeRowPx()}px`);
  style.setProperty("font-size", `${size}px`);
  appliedToDocument = true;
  return true;
}

/**
 * Height of a desktop chrome row: pane headers, query bars, stack detail bars
 * and table header rows. 20px at the default font size, a little taller than a
 * text cell so controls have room, and rounded to whole pixels at every size so
 * rules and text land on the pixel grid. CSS mirrors it as --chrome-h.
 */
export function chromeRowPx(): number {
  return Math.round(WEB_CELL_HEIGHT * 20 / 18);
}
