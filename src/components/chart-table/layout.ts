import { statGridRows, type StatItem } from "../ui/stat-grid";
import { getTableWidth, hasMeaningfulTableHorizontalOverflow, type TableWidthColumn } from "../ui/table-layout";

/** Drop optional columns in priority order, using the same widths as the table. */
export function fitChartTableColumns<C extends TableWidthColumn & { id: string }>(
  columns: readonly C[],
  width: number,
  dropOrder: readonly C["id"][],
): C[] {
  let kept = [...columns];
  for (const id of dropOrder) {
    // Reserve the vertical scrollbar, including when the current rows fit.
    if (getTableWidth(kept) <= width - 1) break;
    kept = kept.filter((column) => column.id !== id);
  }
  return kept;
}

/** A readable kit chart: legend row, four plot rows, time axis. */
export const CHART_MIN_ROWS = 6;
/** The least a kit chart draws in: legend, two plot rows, time axis. Only
 * used for rows a short table leaves, which would otherwise stay blank. */
export const CHART_COMPACT_ROWS = 4;
/** Narrower than this the axis labels no longer fit beside the plot. */
const CHART_MIN_WIDTH = 24;
/** The table keeps its header and this many rows before the chart gives way. */
const TABLE_MIN_BODY_ROWS = 4;
/** The chart's share of what the figures leave, while the table has more rows than fit. */
const CHART_SHARE = 0.4;
/** Below this many body rows the figures keep a single row. */
const SHORT_BODY_ROWS = 12;
/** The figures never take more than this share of the body. */
const FIGURE_SHARE = 0.25;
/** The share of the body figures that wrap rather than cut a date may take, beyond FIGURE_SHARE. */
const WRAPPED_FIGURE_SHARE = 1 / 3;

/**
 * The rows a kit table spends outside its body: the header, plus a horizontal
 * scrollbar when its columns are wider than the pane (less the vertical
 * scrollbar's column).
 */
export function chartTableChromeRows(columns: readonly TableWidthColumn[], width: number): number {
  return hasMeaningfulTableHorizontalOverflow(getTableWidth(columns), width - 1) ? 2 : 1;
}

/**
 * What the band above the table shows: the full chart, one row with the label,
 * a sparkline and the value, or nothing.
 */
export type ChartBandMode = "full" | "strip" | "none";

export interface ChartTableLayoutInput {
  width: number;
  /** Rows the header zone and the table share: the table's `rootHeight`. */
  height: number;
  /** Rows above the figures inside the zone, such as a `QueryBar`. */
  queryRows?: number;
  /** In priority order: the last ones go first when rows run short. */
  figures?: readonly StatItem[];
  /** Body rows the table holds. */
  tableRows: number;
  /** Rows the table spends on its header, plus one when a horizontal scrollbar shows. */
  tableChromeRows?: number;
  /**
   * Null when there is nothing to chart. `compactRows` is the least it can
   * draw in below a short table; `maxRows` caps content with a natural
   * height (a few bars), whose rows beyond it go to the table.
   */
  chart: { minRows?: number; compactRows?: number; maxRows?: number; strip?: boolean } | null;
}

export interface ChartTableLayout {
  figures: StatItem[];
  figureRows: number;
  /** Whether the figures wrap a whole-row cell too narrow for one line (StatGrid's `wrap`). */
  wrapFigures: boolean;
  mode: ChartBandMode;
  chartRows: number;
}

/** Rows `figures` take, wrapped or a line each. */
function figureRows(figures: readonly StatItem[], width: number, wrap: boolean): number {
  return statGridRows([...figures], width, undefined, { wrap });
}

/**
 * The figures that fit the row budget, dropped from the end, as before a
 * whole-row figure could wrap: the same ones a line each. Those wrap rather
 * than cut a date, and may take up to WRAPPED_FIGURE_SHARE of the body for
 * it, when the budget is more than one row; past that they lose figures from
 * the end. A budget of one row, or too small for even the first figure
 * wrapped, keeps them a line each, cut.
 */
function fitFigures(figures: readonly StatItem[], width: number, maxRows: number, body: number): { figures: StatItem[]; wrap: boolean } {
  const kept = [...figures];
  while (kept.length > 0 && figureRows(kept, width, false) > maxRows) kept.pop();
  const wrapCap = maxRows > 1 ? Math.max(maxRows, Math.floor(body * WRAPPED_FIGURE_SHARE)) : maxRows;
  const wrapped = [...kept];
  while (wrapped.length > 0 && figureRows(wrapped, width, true) > wrapCap) wrapped.pop();
  return wrapped.length > 0 ? { figures: wrapped, wrap: true } : { figures: kept, wrap: false };
}

/**
 * The one height rule for a pane that shows figures, then a chart, then a
 * table, at every size:
 *
 * - The table always keeps its header and a few rows (all of them when it has
 *   fewer), so the rows the pane is about never vanish.
 * - The figures take at most a quarter of the body, one row when it is short
 *   or when a second row would cost the chart its place, and lose items from
 *   the end rather than spill; a whole-row figure wraps rather than cut its
 *   detail, unless the rows leave none of them room to.
 * - The chart takes 40% of what is left, or everything the table does not
 *   need when all its rows fit, so no blank band opens under a short table.
 * - Below a readable chart the band becomes a one-row strip, then nothing.
 */
export function chartTableLayout(input: ChartTableLayoutInput): ChartTableLayout {
  const body = Math.max(0, Math.floor(input.height) - (input.queryRows ?? 0));
  const figureCap = body < SHORT_BODY_ROWS ? 1 : Math.max(1, Math.floor(body * FIGURE_SHARE));
  const layout = layoutWithFigureRows(input, body, figureCap);
  // A readable chart is worth more than a second row of figures.
  if (layout.mode !== "full" && layout.figureRows > 1) {
    const tighter = layoutWithFigureRows(input, body, 1);
    if (tighter.mode === "full") return tighter;
  }
  // Without a full chart, rows a short table leaves go back to figures that
  // were dropped, rather than to a blank band under the table.
  if (layout.mode !== "full" && layout.figures.length < (input.figures?.length ?? 0)) {
    const tableFit = (input.tableChromeRows ?? 1) + Math.max(0, input.tableRows);
    const spare = body - layout.figureRows - layout.chartRows - tableFit;
    if (spare > 0) {
      const roomier = layoutWithFigureRows(input, body, layout.figureRows + spare);
      if (roomier.mode === layout.mode && roomier.figureRows > layout.figureRows) return roomier;
    }
  }
  return layout;
}

function layoutWithFigureRows(input: ChartTableLayoutInput, body: number, figureCap: number): ChartTableLayout {
  const width = Math.floor(input.width);
  const tableRows = Math.max(0, input.tableRows);
  const chrome = input.tableChromeRows ?? 1;
  const tableMin = chrome + Math.min(tableRows, TABLE_MIN_BODY_ROWS);
  const tableFit = chrome + tableRows;

  // A table with no room for a single row after the figures gets the body back.
  const figureBudget = Math.min(figureCap, Math.max(0, body - chrome - Math.min(tableRows, 1)));
  const { figures, wrap: wrapFigures } = figureBudget > 0 ? fitFigures(input.figures ?? [], width, figureBudget, body) : { figures: [], wrap: true };
  const shownRows = figures.length ? figureRows(figures, width, wrapFigures) : 0;

  const rest = body - shownRows;
  const none: ChartTableLayout = { figures, figureRows: shownRows, wrapFigures, mode: "none", chartRows: 0 };
  if (!input.chart || width < CHART_MIN_WIDTH) return none;

  const minRows = input.chart.minRows ?? CHART_MIN_ROWS;
  const compactRows = Math.min(minRows, input.chart.compactRows ?? minRows);
  const maxRows = input.chart.maxRows ?? Number.POSITIVE_INFINITY;
  const room = rest - tableMin;
  const spare = rest - tableFit;
  const full = (rows: number): ChartTableLayout => ({ figures, figureRows: shownRows, wrapFigures, mode: "full", chartRows: Math.min(rows, maxRows) });
  if (room >= minRows) {
    // With every table row in view beside a readable chart, the chart takes
    // exactly the rest; otherwise its 40% share, never below what it draws in.
    const share = Math.round(rest * CHART_SHARE);
    return full(spare >= minRows ? spare : Math.min(room, Math.max(minRows, share)));
  }
  // A short table that fits whole: a compact chart fills the rows it leaves
  // instead of a strip over a blank band.
  if (spare >= compactRows) return full(spare);
  if (input.chart.strip !== false && room >= 1) {
    return { figures, figureRows: shownRows, wrapFigures, mode: "strip", chartRows: 1 };
  }
  return none;
}
