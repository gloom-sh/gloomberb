export type TimeRange = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "5Y" | "ALL";
/** A bar size's unit: minutes, hours, days, weeks and months. */
export type ChartBarSizeUnit = "m" | "h" | "d" | "wk" | "mo";
/**
 * A bar size a chart builds from the bars a source serves: `10m` from 5-minute
 * bars, `4h` from hourly ones, `2d` from daily ones. Always in the form
 * `parseChartBarSize` returns; sources and brokers never see one.
 */
export type CustomChartResolution = `${number}${ChartBarSizeUnit}`;
export type ChartResolution = "auto" | "1m" | "5m" | "15m" | "30m" | "45m" | "1h" | "1d" | "1wk" | "1mo" | CustomChartResolution;

export interface ChartDateWindow {
  start: Date | null;
  end: Date | null;
}

export const TIME_RANGES: TimeRange[] = ["1D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"];
export const CHART_RESOLUTIONS: ChartResolution[] = [
  "auto",
  "1m",
  "5m",
  "15m",
  "30m",
  "45m",
  "1h",
  "1d",
  "1wk",
  "1mo",
];
