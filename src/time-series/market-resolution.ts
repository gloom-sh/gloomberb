import {
  CHART_RESOLUTION_STEP_MS,
  type ManualChartResolution,
} from "./resolution";
import { isMarketFieldId } from "./field-catalog";
import type { ChartSeriesSpec, SeriesPeriod } from "./types";

const MARKET_PERIOD_MAX_RESOLUTION: Partial<Record<SeriesPeriod, ManualChartResolution>> = {
  daily: "1d",
  weekly: "1wk",
  monthly: "1mo",
};

export function maximumResolutionForMarketPeriod(
  period: SeriesPeriod | undefined,
): ManualChartResolution | null {
  return period ? MARKET_PERIOD_MAX_RESOLUTION[period] ?? null : null;
}

export function isResolutionFineEnoughForMarketPeriod(
  resolution: ManualChartResolution,
  period: SeriesPeriod | undefined,
): boolean {
  const maximum = maximumResolutionForMarketPeriod(period);
  return maximum === null
    || CHART_RESOLUTION_STEP_MS[resolution] <= CHART_RESOLUTION_STEP_MS[maximum];
}

/** Returns the finest fetch cadence required by explicit market periods. */
function finestExplicitMarketPeriodResolution(
  series: readonly ChartSeriesSpec[],
): ManualChartResolution | null {
  let finest: ManualChartResolution | null = null;
  for (const entry of series) {
    if (entry.source.kind !== "security" || !isMarketFieldId(entry.source.fieldId)) continue;
    const required = maximumResolutionForMarketPeriod(entry.source.period);
    if (!required) continue;
    if (!finest || CHART_RESOLUTION_STEP_MS[required] < CHART_RESOLUTION_STEP_MS[finest]) {
      finest = required;
    }
  }
  return finest;
}

export function resolutionForExplicitMarketPeriods(
  preferred: ManualChartResolution,
  series: readonly ChartSeriesSpec[],
): ManualChartResolution {
  const required = finestExplicitMarketPeriodResolution(series);
  return required && CHART_RESOLUTION_STEP_MS[preferred] > CHART_RESOLUTION_STEP_MS[required]
    ? required
    : preferred;
}
