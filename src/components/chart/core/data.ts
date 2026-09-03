/** One observation of a simple, non-navigable chart: a value with optional bar extremes. */
export interface ProjectedChartPoint {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
