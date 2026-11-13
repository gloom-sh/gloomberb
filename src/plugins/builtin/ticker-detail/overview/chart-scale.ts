import type { PanelScale } from "../../../../time-series/types";

/** The Overview chart's value axis: picked from the history's range, or set by hand. */
export type OverviewChartScaleChoice = "auto" | PanelScale;

/** The research pane setting that remembers a scale set by hand. */
export const OVERVIEW_CHART_SCALE_SETTING = "overviewChartScale";

/**
 * A history whose highest close is at least this many times its lowest opens
 * on a log axis: on a linear one its early years lie flat along the floor.
 */
export const AUTO_LOG_RANGE = 3;

export function parseOverviewChartScaleChoice(value: unknown): OverviewChartScaleChoice {
  return value === "linear" || value === "log" ? value : "auto";
}

/**
 * The scale a history's own range calls for. A close at zero or below, which
 * a log axis cannot place, keeps it linear, and so does a rate (a Treasury
 * yield index), whose level does not compound.
 */
export function autoOverviewChartScale(
  points: ReadonlyArray<{ value: number | null }>,
  options: { rate?: boolean } = {},
): PanelScale {
  if (options.rate) return "linear";
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const { value } of points) {
    if (value === null || !Number.isFinite(value)) continue;
    if (value <= 0) return "linear";
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return high >= low * AUTO_LOG_RANGE ? "log" : "linear";
}

export function resolveOverviewChartScale(choice: OverviewChartScaleChoice, auto: PanelScale): PanelScale {
  return choice === "auto" ? auto : choice;
}

/**
 * The choice after switching the scale shown: the other scale, kept for every
 * ticker the pane shows, or auto again once that is the one the history calls
 * for, so switching back never leaves a choice behind.
 */
export function toggledOverviewChartScale(choice: OverviewChartScaleChoice, auto: PanelScale): OverviewChartScaleChoice {
  const next: PanelScale = resolveOverviewChartScale(choice, auto) === "log" ? "linear" : "log";
  return next === auto ? "auto" : next;
}
