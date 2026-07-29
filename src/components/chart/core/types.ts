import type { PricePoint } from "../../../types/financials";
export type { ChartResolution, TimeRange } from "../../../time-series/range";

export type ChartRenderMode = "area" | "line" | "candles" | "ohlc" | "hlc";
export type ChartAxisMode = "price" | "percent";
export type ChartRendererPreference = "auto" | "kitty" | "braille";
export type ResolvedChartRenderer = "kitty" | "braille";
export type ChartSessionBackgroundKind = "pre" | "post";

export const CHART_RENDERER_PREFERENCES: ChartRendererPreference[] = ["auto", "kitty", "braille"];

export interface Pixel {
  color: string;
  layer: number;
}

export interface PixelBuffer {
  width: number;
  height: number; // virtual pixel rows (4x terminal rows for braille rendering)
  pixels: (Pixel | null)[][]; // [y][x] = pixel with color and layer, or null
  backgrounds: (string | null)[][];
}

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

export interface ChartMarketSession {
  timeZone: string;
  regularStartMinutes: number;
  regularEndMinutes: number;
  preMarketStartMinutes: number;
  postMarketEndMinutes: number;
}

export interface ChartSessionBackgroundSpan {
  kind: ChartSessionBackgroundKind;
  startIndex: number;
  endIndex: number;
}

export interface VisibleWindow {
  points: PricePoint[];
  startIdx: number;
  endIdx: number;
}

import type { OverlayPoint, OscillatorPoint, MacdResult, BollingerResult } from "../indicators/types";

export interface ChartIndicatorOverlays {
  smaLines: { period: number; points: OverlayPoint[]; color: string }[];
  emaLines: { period: number; points: OverlayPoint[]; color: string }[];
  bollinger: (BollingerResult & { color: string }) | null;
  rsi: OscillatorPoint[] | null;
  macd: MacdResult | null;
}
