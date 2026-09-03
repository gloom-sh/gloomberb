export type { ChartResolution, TimeRange } from "../../../time-series/range";

export type ChartRenderMode = "area" | "line" | "candles" | "ohlc" | "hlc";
export type ChartRendererPreference = "auto" | "kitty" | "braille";
export type ResolvedChartRenderer = "kitty" | "braille";

export const CHART_RENDERER_PREFERENCES: ChartRendererPreference[] = ["auto", "kitty", "braille"];

export interface ChartColors {
  lineColor: string;
  fillColor: string;
  volumeUp: string;
  volumeDown: string;
  gridColor: string;
  crosshairColor: string;
  bgColor: string;
  axisColor: string;
  activeRangeColor: string;
  inactiveRangeColor: string;
  preMarketBgColor: string;
  postMarketBgColor: string;
}
