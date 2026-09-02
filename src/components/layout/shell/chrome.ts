import { TITLEBAR_OVERLAY_HEIGHT_PX, getTitlebarLeadingInset } from "../titlebar-overlay";

export const DEFAULT_HEADER_HEIGHT = 1;

const HEADER_PROMPT_MIN_WIDTH = 10;
/** Columns the header keeps free right of the prompt for the update status. */
const HEADER_PROMPT_UPDATE_COLUMNS = 14;
/**
 * Width the prompt holds before the market cluster is offered anything. Above
 * the command surface minimum so a mid-size window does not hand the cluster a
 * whole tier and leave the sheet sitting on its floor.
 */
const HEADER_PROMPT_COMFORT_WIDTH = 48;
/** Narrowest command surface, by host: a document snippet still reads here. */
const COMMAND_SURFACE_MIN_WIDTH = { native: 46, terminal: 42 };

/**
 * The market cluster's reserve at the header's right edge, widest first. Each
 * step is the worst case for what it shows, so a ticking countdown or a longer
 * state label can never push the cluster past its columns:
 *
 *   42  PRE-MKT · 5h 30m  SPY 1,234.56 -10.60%  USD
 *   31  the state label and SPY
 *   21  SPY alone
 *
 * Steps rather than a share of the window: a reserve of, say, 18 columns is
 * too narrow for anything and would waste all 18. There is deliberately no
 * step for "everything but the countdown", which would cost the sheet eleven
 * columns to add the base currency, the one value here that barely moves.
 */
const HEADER_MARKET_TIERS = [42, 31, 21] as const;

/**
 * Update status is transient, so on a narrow header it gives most of its
 * reserve back rather than shortening the placeholder that has to sell the
 * command bar to a first-time user.
 */
function headerPromptUpdateColumns(termWidth: number): number {
  return Math.min(HEADER_PROMPT_UPDATE_COLUMNS, Math.max(4, Math.floor(termWidth * 0.12)));
}

/**
 * Columns the market cluster gets, from the terminal width alone: a reserve
 * that tracked the quote would resize the prompt every time SPY ticked.
 */
function headerMarketColumns(termWidth: number, left: number, updateColumns: number): number {
  const spare = termWidth - left - updateColumns - HEADER_PROMPT_COMFORT_WIDTH;
  return HEADER_MARKET_TIERS.find((tier) => tier <= spare) ?? 0;
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
    ? Math.max(COMMAND_SURFACE_MIN_WIDTH.native, Math.min(104, termWidth - 10, Math.floor(termWidth * 0.64)))
    : Math.max(COMMAND_SURFACE_MIN_WIDTH.terminal, Math.min(96, termWidth - 8, Math.floor(termWidth * 0.68)));
}

export interface HeaderPromptGeometry {
  /** Column the prompt starts at. */
  left: number;
  width: number;
  /** Columns held at the header's right edge for the market cluster. */
  marketColumns: number;
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
  const left = leadingInset + 1;
  const updateColumns = headerPromptUpdateColumns(termWidth);
  const marketColumns = headerMarketColumns(termWidth, left, updateColumns);
  const width = Math.max(
    HEADER_PROMPT_MIN_WIDTH,
    Math.min(
      resolveCommandSurfaceWidth({ nativePaneChrome, termWidth }),
      termWidth - left - updateColumns - marketColumns,
    ),
  );
  return { left, width, marketColumns };
}
