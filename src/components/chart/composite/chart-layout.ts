import { allocateCompositePanelHeights } from "./scene";

/**
 * How a chart pane lays its chart out, as the user left it: the panels'
 * heights, a panel given the whole plot, the drawing tool bar hidden and the
 * legend collapsed. Kept in the pane's settings beside its drawings, so it
 * outlives a restart; a chart outside a pane keeps it while it is mounted.
 */
export const CHART_LAYOUT_SETTING_KEY = "chartLayout";

export interface ChartLayoutPrefs {
  /**
   * Panel heights set by hand, by panel id, as weights in the unit of the
   * panels' own `height`, so a panel added later takes its usual share.
   */
  panelWeights?: Readonly<Record<string, number>>;
  /** The panel given the whole plot while the others wait. */
  maximizedPanelId?: string;
  /** The drawing tool bar is folded to the one button that brings it back. */
  toolbarHidden?: boolean;
  /** The legend shows its first series and how many more it holds. */
  legendCollapsed?: boolean;
}

export const NO_CHART_LAYOUT: ChartLayoutPrefs = Object.freeze({});

/** Whatever the settings hold, read as a layout: anything malformed is left out. */
export function parseChartLayoutPrefs(value: unknown): ChartLayoutPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return NO_CHART_LAYOUT;
  const source = value as Record<string, unknown>;
  const layout: ChartLayoutPrefs = {};
  if (source.panelWeights && typeof source.panelWeights === "object" && !Array.isArray(source.panelWeights)) {
    const weights = Object.entries(source.panelWeights as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0);
    if (weights.length > 0) layout.panelWeights = Object.fromEntries(weights);
  }
  if (typeof source.maximizedPanelId === "string" && source.maximizedPanelId) layout.maximizedPanelId = source.maximizedPanelId;
  if (source.toolbarHidden === true) layout.toolbarHidden = true;
  if (source.legendCollapsed === true) layout.legendCollapsed = true;
  return Object.keys(layout).length > 0 ? layout : NO_CHART_LAYOUT;
}

/** The layout with `patch` applied, dropping what is back to its default so a reset stores nothing. */
export function patchChartLayout(layout: ChartLayoutPrefs, patch: ChartLayoutPrefs): ChartLayoutPrefs {
  const next: ChartLayoutPrefs = { ...layout, ...patch };
  for (const key of Object.keys(next) as (keyof ChartLayoutPrefs)[]) {
    if (next[key] === undefined || next[key] === false) delete next[key];
  }
  return parseChartLayoutPrefs(next);
}

/** The fewest rows a panel keeps under a drag or a key: two where the plot has them. */
export function minimumPanelRows(plotRows: number, panelCount: number): number {
  return plotRows >= panelCount * 2 ? 2 : 1;
}

/**
 * Rows as weights in the unit the panels' own weights add up to (`weightTotal`
 * over the same panels), so each panel lays out at exactly its rows and a
 * pane resized later keeps the split.
 */
export function weightsFromRows(
  rows: readonly { id: string; rows: number }[],
  weightTotal: number,
): Record<string, number> {
  const rowTotal = rows.reduce((sum, entry) => sum + entry.rows, 0);
  const unit = rowTotal > 0 && weightTotal > 0 ? weightTotal / rowTotal : 1;
  return Object.fromEntries(rows.map(({ id, rows: count }) => [id, Math.round(count * unit * 10_000) / 10_000]));
}

/**
 * The boundary above panel `index` moved down by `deltaRows` (up when
 * negative): the panel above gains what the one below gives, each keeping
 * `minRows`. The others keep theirs.
 */
export function movePanelBoundary(rows: readonly number[], index: number, deltaRows: number, minRows: number): number[] {
  const next = [...rows];
  if (index <= 0 || index >= rows.length) return next;
  const above = rows[index - 1]!;
  const below = rows[index]!;
  // A panel already under the minimum (a short chart) is never squeezed further.
  const lowest = Math.min(0, Math.min(minRows, above) - above);
  const highest = Math.max(0, below - Math.min(minRows, below));
  const delta = Math.max(lowest, Math.min(highest, Math.round(deltaRows)));
  next[index - 1] = above + delta;
  next[index] = below - delta;
  return next;
}

/**
 * The weights a drag on the line above panel `index` sets, from the rows the
 * panels had when it started: null until the line has moved a whole row, so
 * a click that jitters by a few pixels keeps the split as it was.
 */
export function draggedPanelWeights(
  start: { rows: readonly { id: string; rows: number }[]; weightTotal: number },
  index: number,
  deltaRows: number,
  minRows: number,
): Record<string, number> | null {
  const rows = start.rows.map((entry) => entry.rows);
  const next = movePanelBoundary(rows, index, deltaRows, minRows);
  if (next.every((count, position) => count === rows[position])) return null;
  return weightsFromRows(start.rows.map((entry, position) => ({ id: entry.id, rows: next[position]! })), start.weightTotal);
}

/**
 * The top panel's weight for it to lay out a row taller (1) or shorter (-1).
 * The panels below keep their weights, so they share what is left as they did
 * and a step back undoes a step. Null when the top panel would go under
 * `minRows`, or a panel below that has it would.
 */
export function stepTopPanel(
  panels: readonly { rows: number; weight: number }[],
  direction: 1 | -1,
  minRows: number,
): number | null {
  if (panels.length < 2) return null;
  const total = panels.reduce((sum, panel) => sum + panel.rows, 0);
  const lowerWeight = panels.slice(1).reduce((sum, panel) => sum + panel.weight, 0);
  const current = panels[0]!.rows;
  const top = current + direction;
  if (top < Math.min(minRows, current) || top >= total || !(lowerWeight > 0)) return null;
  const weight = lowerWeight * top / (total - top);
  const laidOut = [...allocateCompositePanelHeights(
    panels.map((panel, index) => ({ id: String(index), height: index === 0 ? weight : panel.weight })),
    total,
  ).values()];
  if (laidOut[0] !== top) return null;
  return laidOut.every((rows, index) => index === 0 || rows >= Math.min(minRows, panels[index]!.rows)) ? weight : null;
}
