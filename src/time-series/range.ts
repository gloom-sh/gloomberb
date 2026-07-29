export type TimeRange = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "5Y" | "ALL";
export type ChartResolution = "auto" | "1m" | "5m" | "15m" | "30m" | "45m" | "1h" | "1d" | "1wk" | "1mo";

export interface ChartDateWindow {
  start: Date | null;
  end: Date | null;
}

export const TIME_RANGES: TimeRange[] = ["1D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"];
