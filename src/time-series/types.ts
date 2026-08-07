import type { ChartResolution, TimeRange } from "./range";
import type { ChartResolutionSupport } from "./resolution";
import type { InstrumentRef } from "../market-data/request-types";

export const CHART_SPEC_VERSION = 1 as const;

export type SeriesPeriod = "auto" | "daily" | "weekly" | "monthly" | "quarterly" | "annual" | "ttm";
export type SeriesStyle = "line" | "area" | "step" | "columns" | "points" | "candles" | "ohlc" | "hlc";
export type SeriesTransform = "raw" | "percent" | "index100" | "yoy" | "qoq" | "log";
export type SeriesAxis = "auto" | "left" | "right";
export type SeriesInterpolation = "none" | "step-after";
export type SeriesTimestampMode = "available-at" | "period-end";
export type PanelScale = "linear" | "log";

export interface SecuritySeriesSource {
  kind: "security";
  instrument: InstrumentRef;
  fieldId: string;
  period?: SeriesPeriod;
  timestampMode?: SeriesTimestampMode;
}

export interface EconomicSeriesSource {
  kind: "economic";
  provider: "fred";
  seriesId: string;
}

export type ChartSeriesSource = SecuritySeriesSource | EconomicSeriesSource;

export interface ChartSeriesSpec {
  id: string;
  source: ChartSeriesSource;
  label?: string;
  style: SeriesStyle;
  transform: SeriesTransform;
  axis: SeriesAxis;
  panelId: string;
  interpolation: SeriesInterpolation;
  color?: string;
  visible?: boolean;
}

export type ChartStudyKind =
  | "volume"
  | "sma"
  | "ema"
  | "bollinger"
  | "rsi"
  | "macd"
  | "ratio"
  | "spread"
  | "correlation";

export interface ChartStudySpec {
  id: string;
  kind: ChartStudyKind;
  inputSeriesIds: string[];
  parameters: Record<string, number>;
  panelId: string;
  axis: SeriesAxis;
  color?: string;
  visible?: boolean;
}

export interface ChartPanelSpec {
  id: string;
  label?: string;
  height?: number;
  scale?: PanelScale;
}

export interface ChartViewportSpec {
  range: TimeRange;
  resolution: ChartResolution;
  dateWindow?: { start: string; end: string };
  /** Optional latest-observation cap, useful for period-based financial views. */
  maxPoints?: number;
}

export interface ChartSpec {
  version: typeof CHART_SPEC_VERSION;
  viewport: ChartViewportSpec;
  panels: ChartPanelSpec[];
  series: ChartSeriesSpec[];
  studies: ChartStudySpec[];
}

export type SeriesDataShape = "scalar" | "ohlcv" | "event" | "band";

export interface TimeSeriesPoint {
  date: Date;
  observedAt: Date;
  availableAt?: Date;
  value: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
  periodLabel?: string;
  provenance?: {
    providerId?: string;
    quality?: "reported" | "derived" | "estimated";
  };
}

export interface ResolvedSeriesMarketTimeBasis {
  kind: "market";
  /** IANA timezone used to recognize one exchange-local trading day. */
  timeZone: string;
  /** Requested bar cadence when known; otherwise the chart derives it. */
  cadenceMs?: number;
}

export interface ResolvedSeries {
  id: string;
  label: string;
  color: string;
  unit: string;
  unitGroup: string;
  nativeFrequency: SeriesPeriod;
  /** Authored time basis retained for layout and cursor semantics. */
  timestampMode?: SeriesTimestampMode;
  dataShape: SeriesDataShape;
  style: SeriesStyle;
  transform: SeriesTransform;
  axis: Exclude<SeriesAxis, "auto">;
  panelId: string;
  interpolation: SeriesInterpolation;
  /** Present only for exchange-traded market observations. */
  timeBasis?: ResolvedSeriesMarketTimeBasis;
  /** Regular-session move supplied with the latest market quote. */
  latestChangePercent?: number;
  points: TimeSeriesPoint[];
  warning?: string;
  /** Listed in the legend so it can be restored, but not drawn. */
  hidden?: boolean;
}

export interface TimeSeriesFieldDefinition {
  id: string;
  label: string;
  shortLabel: string;
  sourceKind: ChartSeriesSource["kind"];
  dataShape: SeriesDataShape;
  unit: string;
  unitGroup: string;
  nativeFrequency: SeriesPeriod;
  styles: SeriesStyle[];
  defaultStyle: SeriesStyle;
  transforms: SeriesTransform[];
  defaultInterpolation: SeriesInterpolation;
}

export interface ChartResolutionResult {
  series: ResolvedSeries[];
  /** Provider capabilities shared by every active market series. */
  resolutionSupport?: ChartResolutionSupport[];
  /** Series available to the legend, including hidden base series that can be restored. */
  legendSeries?: ResolvedSeries[];
  /** Loaded observations retained outside the visible window for interactive navigation. */
  bufferedSeries?: ResolvedSeries[];
  /** Hidden market data retained as a deterministic session-time anchor. */
  timelineSeries?: ResolvedSeries[];
  loading: boolean;
  errors: string[];
  warnings: string[];
  /** Effective inclusive bounds used to clip the resolved chart data. */
  viewport?: { start: Date; end: Date };
}
