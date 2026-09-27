import { statGridRows, type StatItem } from "../ui/stat-grid";

/** A readable kit chart: legend row, four plot rows, time axis. */
export const CHART_MIN_ROWS = 6;
/** Narrower than this the axis labels no longer fit beside the plot. */
export const CHART_MIN_WIDTH = 24;
/** The table keeps its header and this many rows before the chart gives way. */
export const TABLE_MIN_BODY_ROWS = 4;
/** The chart's share of what the figures leave, while the table has more rows than fit. */
export const CHART_SHARE = 0.4;
/** Below this many body rows the figures keep a single row. */
const SHORT_BODY_ROWS = 12;
/** The figures never take more than this share of the body. */
const FIGURE_SHARE = 0.25;

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
  /** Null when there is nothing to chart. */
  chart: { minRows?: number; strip?: boolean } | null;
}

export interface ChartTableLayout {
  figures: StatItem[];
  figureRows: number;
  mode: ChartBandMode;
  chartRows: number;
}

/** Drops figures from the end until they fit the row budget. */
function fitFigures(figures: readonly StatItem[], width: number, maxRows: number): StatItem[] {
  const kept = [...figures];
  while (kept.length > 0 && statGridRows(kept, width) > maxRows) kept.pop();
  return kept;
}

/**
 * The one height rule for a pane that shows figures, then a chart, then a
 * table, at every size:
 *
 * - The table always keeps its header and a few rows (all of them when it has
 *   fewer), so the rows the pane is about never vanish.
 * - The figures take at most a quarter of the body, one row when it is short
 *   or when a second row would cost the chart its place, and lose items from
 *   the end rather than wrap.
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
  const figures = figureBudget > 0 ? fitFigures(input.figures ?? [], width, figureBudget) : [];
  const figureRows = figures.length ? statGridRows(figures, width) : 0;

  const rest = body - figureRows;
  const none: ChartTableLayout = { figures, figureRows, mode: "none", chartRows: 0 };
  if (!input.chart || width < CHART_MIN_WIDTH) return none;

  const minRows = input.chart.minRows ?? CHART_MIN_ROWS;
  const room = rest - tableMin;
  if (room >= minRows) {
    const share = Math.round(rest * CHART_SHARE);
    const spare = rest - tableFit;
    const chartRows = spare >= share ? spare : Math.min(room, Math.max(minRows, share));
    return { figures, figureRows, mode: "full", chartRows };
  }
  if (input.chart.strip !== false && room >= 1) {
    return { figures, figureRows, mode: "strip", chartRows: 1 };
  }
  return none;
}
