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
 * Market budgets used to size the command prompt, widest first. These stay
 * independent of label wording so a longer countdown cannot resize the prompt
 * or the sheet attached to it:
 *
 *   42  state, SPY, currency and a short countdown
 *   31  the state label and SPY
 *   21  SPY alone
 *
 * Steps rather than a share of the window: a reserve of, say, 18 columns is
 * too narrow for anything and would waste all 18. There is deliberately no
 * step for "everything but the countdown", which would cost the sheet eleven
 * columns to add the base currency, the one value here that barely moves.
 */
const HEADER_MARKET_TIERS = [42, 31, 21] as const;
/** Full pre-market label, including "to regular open", when spare room allows. */
const HEADER_MARKET_FULL_COLUMNS = 58;

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
function resolveCommandSurfaceWidth(options: { termWidth: number; nativePaneChrome?: boolean }): number {
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
  /**
   * Columns between the prompt and the market cluster: the update status, its
   * padding and the Help pill share them. Never negative, so a window too narrow
   * for the header reads as no room rather than a negative width.
   */
  updateColumns: number;
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
  /** Sniffed from the host when absent. */
  platform?: string;
  titleBarOverlay?: boolean;
  windowFullscreen?: boolean;
  /** An active update status keeps its spare room ahead of a longer market label. */
  allowMarketExpansion?: boolean;
}): HeaderPromptGeometry {
  const { nativePaneChrome, platform, termWidth, titleBarOverlay, windowFullscreen } = options;
  const nativeWindowChrome = options.nativeWindowChrome ?? titleBarOverlay;
  const leadingInset = titleBarOverlay && nativeWindowChrome
    ? getTitlebarLeadingInset({ platform, windowFullscreen })
    : 0;
  const left = leadingInset + 1;
  const updateReserve = headerPromptUpdateColumns(termWidth);
  const marketReserve = headerMarketColumns(termWidth, left, updateReserve);
  const width = Math.max(
    HEADER_PROMPT_MIN_WIDTH,
    Math.min(
      resolveCommandSurfaceWidth({ nativePaneChrome, termWidth }),
      termWidth - left - updateReserve - marketReserve,
    ),
  );
  // Spend only space left after the prompt and update reserve have their room.
  // The longer market label gives way before either can lose a column.
  const marketColumns = options.allowMarketExpansion !== false
    && termWidth - left - width - updateReserve >= HEADER_MARKET_FULL_COLUMNS
    ? HEADER_MARKET_FULL_COLUMNS
    : marketReserve;
  return { left, width, marketColumns, updateColumns: Math.max(0, termWidth - left - width - marketColumns) };
}
