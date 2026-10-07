import type { ChartResolution, TimeRange } from "./range";
import type { ChartResolutionSupport, ManualChartResolution } from "./resolution";
import type { InstrumentRef } from "../market-data/request-types";

export const CHART_SPEC_VERSION = 2 as const;

export type SeriesPeriod = "auto" | "daily" | "weekly" | "monthly" | "quarterly" | "annual" | "ttm";
/**
 * "band" draws a line through each point's value inside a shaded range from
 * its `low` to its `high`: an average within its historical range.
 */
export type SeriesStyle = "line" | "area" | "step" | "columns" | "points" | "candles" | "ohlc" | "hlc" | "band";
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

/** Persisted provider-owned source. The opaque series ID includes provider lookup identity. */
export interface CapabilitySeriesSource {
  kind: "capability";
  capabilityId: string;
  seriesId: string;
}

export type ChartSeriesSource = SecuritySeriesSource | EconomicSeriesSource | CapabilitySeriesSource;

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
  | "realized-vol"
  | "vwap"
  | "anchored-vwap"
  | "volume-profile"
  | "atr"
  | "ratio"
  | "spread"
  | "correlation";

export interface ChartStudySpec {
  id: string;
  kind: ChartStudyKind;
  inputSeriesIds: string[];
  parameters: Record<string, number | string>;
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
  /** Intraday market history includes pre-market and after-hours bars where the venue has them. */
  extendedHours?: boolean;
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
  /** Original primary scalar before any presentation transform, including missing values. */
  rawValue?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
  periodLabel?: string;
  provenance?: {
    priceHistoryIntegrity?: import("../utils/price-history-integrity").PriceHistoryIntegrity;
    valuationPriceIssues?: import("./valuation-price").ValuationPriceIssue[];
    secEpsBasis?: import("../utils/sec-eps-basis").SecEpsBasis;
    /** @deprecated No longer populated. */
    earningsResult?: import("../types/financials").EarningsResultProvenance;
    unavailableEarnings?: import("../types/financials").EarningsField[];
    /** @deprecated No longer populated. */
    operatingResult?: import("../types/financials").OperatingResult;
    /** @deprecated No longer populated. */
    operatingResultAggregation?: import("../types/financials").OperatingResultAggregation;
    providerId?: string;
    quality?: "reported" | "derived" | "estimated";
    /** Reporting currency of this monetary statement observation. */
    currency?: string;
  };
}

export interface ResolvedSeriesMarketTimeBasis {
  kind: "market";
  /** IANA timezone used to recognize one exchange-local trading day. */
  timeZone: string;
  /** Canonical listing exchange, which sets the regular session's hours. */
  exchange?: string;
  /** Requested bar cadence when known; otherwise the chart derives it. */
  cadenceMs?: number;
}

export interface ResolvedSeries {
  id: string;
  label: string;
  color: string;
  unit: string;
  /** Unit of rawValue, retained when presentation transforms change unit. */
  rawUnit?: string;
  unitGroup: string;
  /** Source instrument category used only for monetary market-price precision. */
  priceAssetCategory?: string;
  /** Volume basis established by the source instrument; omitted when unspecified. */
  volumeUnit?: "shares" | "contracts";
  nativeFrequency: SeriesPeriod;
  /** Acquired market-history cadence; null is explicitly unknown, undefined is legacy or nonmarket. */
  historyResolution?: ManualChartResolution | null;
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
  /**
   * The listing a market field reads, whose trading sessions studies such as
   * VWAP follow. Set even where no exchange time zone is known (futures).
   */
  listing?: { symbol: string; exchange: string };
  /** Price/volume observations and their derived studies, including 24/7
   * markets. Independent of whether the chart compresses exchange sessions. */
  observationKind?: "market";
  /** Regular-session move supplied with the latest market quote. */
  latestChangePercent?: number;
  /** The previous session's close, set on a one-day chart's price series and drawn as its reference line. */
  priorClose?: number;
  points: TimeSeriesPoint[];
  /** Rejected valuation price inputs, retained independently of usable observations. */
  valuationPriceIssues?: import("./valuation-price").ValuationPriceIssue[];
  warning?: string;
  /** Listed in the legend so it can be restored, but not drawn. */
  hidden?: boolean;
  /** Columns below zero take this colour instead, so a change reads by its sign. */
  negativeColor?: string;
  /**
   * Drawn as the volume traded at each price over the bars in view, against
   * the right edge, instead of as a line through its points.
   */
  profile?: { rows: number };
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

export interface ChartSeriesPriceHistoryIntegrity {
  seriesId: string;
  label: string;
  /** A selected source row, or a visible calculation affected by an earlier row. */
  scope: "requested-observation" | "visible-calculation";
  integrity: import("../utils/price-history-integrity").PriceHistoryIntegrity;
}

export interface ChartResolutionResult {
  series: ResolvedSeries[];
  /** Survives comparison clipping; contains selected rows and affected visible calculations, not unrelated loaded history. */
  priceHistoryIntegrity?: ChartSeriesPriceHistoryIntegrity[];
  /** Method and exact shared source dates for normalized closing-price comparisons. */
  priceComparison?: import("./price-comparison").PriceComparison;
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
  /** Bar resolution the loaded market history was fetched at. */
  resolution?: ManualChartResolution;
}
