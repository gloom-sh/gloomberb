import type { ResolvedSeries, TimeSeriesPoint } from "../time-series/types";

/** One observation at a day ("2025-01-02", midnight UTC), a full ISO timestamp or a Date. */
export function createTestSeriesPoint(date: string | Date, value: number | null = 1): TimeSeriesPoint {
  const observedAt = date instanceof Date ? date : new Date(date);
  return { date: observedAt, observedAt, value };
}

/** A resolved daily USD line on the main panel's left axis; override what the test is about. */
export function createTestResolvedSeries(
  overrides: Partial<ResolvedSeries> & Pick<ResolvedSeries, "id" | "points">,
): ResolvedSeries {
  return {
    label: overrides.id,
    color: "#00ff66",
    unit: "USD",
    unitGroup: "currency",
    nativeFrequency: "daily",
    dataShape: "scalar",
    style: "line",
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: "none",
    ...overrides,
  };
}
