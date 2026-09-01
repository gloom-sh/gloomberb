import { TITLEBAR_OVERLAY_HEIGHT_PX, getTitlebarLeadingInset } from "../titlebar-overlay";

export const DEFAULT_HEADER_HEIGHT = 1;

const HEADER_PROMPT_MIN_WIDTH = 10;
/** Columns the header keeps free right of the prompt for the update status. */
const HEADER_PROMPT_TRAILING_COLUMNS = 14;

/**
 * Update status is transient, so on a narrow header it gives most of its
 * reserve back rather than shortening the placeholder that has to sell the
 * command bar to a first-time user.
 */
function headerPromptTrailingColumns(termWidth: number): number {
  return Math.min(HEADER_PROMPT_TRAILING_COLUMNS, Math.max(4, Math.floor(termWidth * 0.12)));
}


export function resolveAppHeaderHeightCells(options: { titleBarOverlay?: boolean; cellHeightPx?: number }): number {
  if (!options.titleBarOverlay || !options.cellHeightPx || options.cellHeightPx <= 0) return DEFAULT_HEADER_HEIGHT;
  return TITLEBAR_OVERLAY_HEIGHT_PX / options.cellHeightPx;
}

/**
 * Width shared by the header prompt and the command sheet that drops out of
 * it, so the sheet reads as the prompt expanding downward. A fraction of the
 * window so the update status and the Help pill keep their place, capped where
 * a document snippet still has room but a label does not run past where the
 * eye goes.
 */
export function resolveCommandSurfaceWidth(options: { termWidth: number; nativePaneChrome?: boolean }): number {
  const { termWidth } = options;
  return options.nativePaneChrome
    ? Math.max(46, Math.min(104, termWidth - 10, Math.floor(termWidth * 0.64)))
    : Math.max(42, Math.min(96, termWidth - 8, Math.floor(termWidth * 0.68)));
}

export interface HeaderPromptGeometry {
  /** Column the prompt starts at. */
  left: number;
  width: number;
}

/**
 * Geometry of the always-visible command prompt in the header. While the
 * command bar is open the same prompt hosts its input, so the geometry never
 * changes underneath the user.
 */
export function resolveHeaderPromptGeometry(options: {
  termWidth: number;
  nativePaneChrome?: boolean;
  nativeWindowChrome?: boolean;
  titleBarOverlay?: boolean;
}): HeaderPromptGeometry {
  const { nativePaneChrome, termWidth, titleBarOverlay } = options;
  const nativeWindowChrome = options.nativeWindowChrome ?? titleBarOverlay;
  const leadingInset = titleBarOverlay && nativeWindowChrome ? getTitlebarLeadingInset() : 0;
  const trailing = headerPromptTrailingColumns(termWidth);
  const left = leadingInset + 1;
  const width = Math.max(
    HEADER_PROMPT_MIN_WIDTH,
    Math.min(
      resolveCommandSurfaceWidth({ nativePaneChrome, termWidth }),
      termWidth - left - trailing,
    ),
  );
  return { left, width };
}
