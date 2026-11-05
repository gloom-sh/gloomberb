/**
 * Font scaling for the DOM renderer.
 *
 * Every web measurement — pane geometry, table rows, floating windows, the
 * command bar — is expressed in grid cells, so the whole app scales by resizing
 * the cell in step with the root font size rather than by restyling each pane.
 * `WEB_CELL_WIDTH` / `WEB_CELL_HEIGHT` are live bindings: importers read the
 * current value, and a re-render after `syncFontScale()` picks up the new grid.
 * The kit's Box and Text skip a render while their props stay the same, so a
 * box sized in cells would keep the old grid's pixels; the DOM host providers
 * follow `subscribeCellGrid` and re-render every kit element when the grid
 * changes (dom-host-providers.tsx).
 *
 * The terminal renderer owns no font (the emulator does), so this no-ops there.
 */

const BASE_FONT_SIZE_PX = 12;
export const MIN_FONT_SIZE_PX = 10;
const MAX_FONT_SIZE_PX = 20;

const BASE_CELL_WIDTH_PX = 8;
const BASE_CELL_HEIGHT_PX = 18;

export let WEB_CELL_WIDTH: number = BASE_CELL_WIDTH_PX;
export let WEB_CELL_HEIGHT: number = BASE_CELL_HEIGHT_PX;

let appliedFontSizePx = BASE_FONT_SIZE_PX;
let appliedToDocument = false;
let cellGrid = 0;
const cellGridListeners = new Set<() => void>();

/** A number that changes whenever the cell size does. */
export function cellGridRevision(): number {
  return cellGrid;
}

/** Calls `listener` after the cell size changes. Returns the unsubscribe. */
export function subscribeCellGrid(listener: () => void): () => void {
  cellGridListeners.add(listener);
  return () => {
    cellGridListeners.delete(listener);
  };
}

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
  const width = roundToHundredth(BASE_CELL_WIDTH_PX * scale);
  const height = roundToHundredth(BASE_CELL_HEIGHT_PX * scale);
  const gridChanged = width !== WEB_CELL_WIDTH || height !== WEB_CELL_HEIGHT;
  WEB_CELL_WIDTH = width;
  WEB_CELL_HEIGHT = height;

  const style = (globalThis as {
    document?: { body?: { style?: { setProperty: (name: string, value: string) => void } } };
  }).document?.body?.style;
  if (!style) {
    if (gridChanged) notifyCellGrid();
    return false;
  }

  style.setProperty("--cell-w", `${WEB_CELL_WIDTH}px`);
  style.setProperty("--cell-h", `${WEB_CELL_HEIGHT}px`);
  style.setProperty("--chrome-h", `${chromeRowPx()}px`);
  style.setProperty("font-size", `${size}px`);
  // The type, spacing and inset tokens in styles.css scale with it.
  style.setProperty("--gloom-font-scale", String(roundToHundredth(scale)));
  appliedToDocument = true;
  if (gridChanged) notifyCellGrid();
  return true;
}

function notifyCellGrid(): void {
  cellGrid += 1;
  for (const listener of cellGridListeners) listener();
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
