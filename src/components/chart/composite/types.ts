import type { ReactNode } from "react";
import type {
  ChartPanelSpec,
  PanelScale,
  ResolvedSeries,
  TimeSeriesPoint,
} from "../../../time-series/types";

export type CompositeAxisSide = "left" | "right";

export interface CompositeChartColors {
  background: string;
  grid: string;
  crosshair: string;
  text: string;
  textDim: string;
  negative: string;
}

export interface CompositeAxisDomain {
  side: CompositeAxisSide;
  min: number;
  max: number;
  scale: PanelScale;
  unit: string;
  unitGroup: string;
  seriesIds: string[];
}

export interface CompositeProjectedPoint {
  point: TimeSeriesPoint;
  timestamp: number;
  value: number;
  xRatio: number;
  /** Primary-market anchor slot when projection snapped to a trading observation. */
  xSlot?: number;
  yRatio: number;
  /** True when this point starts after a null, invalid, or log-hidden gap. */
  breakBefore: boolean;
}

export interface CompositeCalendarTimeScale {
  kind: "calendar";
  startTime: number;
  endTime: number;
  /**
   * Empty space reserved after `endTime`, as a fraction of the visible span.
   * The 0..1 projection covers `startTime` to `endTime` plus that space, so
   * the newest observation is drawn whole with air after it. Absent means none.
   */
  rightOffsetRatio?: number;
}

export interface CompositeMarketTimeScale {
  kind: "market";
  startTime: number;
  endTime: number;
  anchorSeriesId: string;
  cadenceMs: number;
  anchors: Array<{
    timestamp: number;
    position: number;
  }>;
  startPosition: number;
  /** Slot of `endTime`; the reserved right offset extends past it. */
  endPosition: number;
  /** Empty slots reserved after `endPosition`, as a fraction of the visible span. */
  rightOffsetRatio?: number;
}

export type CompositeTimeScale = CompositeCalendarTimeScale | CompositeMarketTimeScale;

export interface CompositeProjectedSeries {
  source: ResolvedSeries;
  points: CompositeProjectedPoint[];
}

/** Level line at the newest close of the chart's primary price series. */
export interface CompositeLastPriceMarker {
  seriesId: string;
  color: string;
  axis: CompositeAxisSide;
  value: number;
  yRatio: number;
}

export interface CompositePanelScene {
  id: string;
  label?: string;
  height: number;
  scale: PanelScale;
  axes: Partial<Record<CompositeAxisSide, CompositeAxisDomain>>;
  series: CompositeProjectedSeries[];
  /** Present only on the panel that holds the primary price series. */
  lastPrice?: CompositeLastPriceMarker;
}

export interface CompositeCursorValue {
  seriesId: string;
  label: string;
  color: string;
  unit: string;
  value: number | null;
  point: TimeSeriesPoint | null;
}

export interface CompositeChartScene {
  width: number;
  height: number;
  startTime: number;
  endTime: number;
  timeScale: CompositeTimeScale;
  dates: Date[];
  /** Projected positions aligned with `dates`, used for pointer snapping. */
  dateRatios: number[];
  panels: CompositePanelScene[];
  cursorDate: Date | null;
  cursorXRatio: number | null;
  cursorValues: CompositeCursorValue[];
}

export interface BuildCompositeChartSceneOptions {
  width: number;
  height: number;
  cursorDate?: Date | null;
  viewport?: {
    start: Date;
    end: Date;
  };
  /** Authored series order retained even when the primary anchor is hidden. */
  timelineSeries?: ResolvedSeries[];
  /**
   * Empty space kept after the newest observation, as a fraction of the visible
   * span. Defaults to `COMPOSITE_RIGHT_OFFSET_RATIO`; pass 0 for charts whose x
   * is not time, where the last observation belongs at the right edge.
   */
  rightOffsetRatio?: number;
}

export interface CompositeChartXMarker {
  id: string;
  xRatio: number;
  label?: string;
  color?: string;
  lineChar?: string;
}

/** Replaces the date axis for charts whose x is not time: a fraction, a tenor, a return. */
export interface CompositeChartXAxis {
  /** Evenly spread labels drawn instead of date ticks. */
  labels?: readonly string[];
  /** Vertical guide lines through the plot, captioned below the axis. */
  markers?: readonly CompositeChartXMarker[];
  formatCursor?: (xRatio: number) => string;
}

export interface CompositeChartProps {
  series: ResolvedSeries[];
  /** Optional legend model; can include hidden series that are not plotted. */
  legendSeries?: ResolvedSeries[];
  /** Optional hidden market series used to preserve session-time navigation. */
  timelineSeries?: ResolvedSeries[];
  panels: ChartPanelSpec[];
  width: number;
  height: number;
  focused?: boolean;
  interactive?: boolean;
  /** False keeps the hover cursor but removes pan, zoom, tools, and navigation keys. */
  navigable?: boolean;
  /** Overrides the unit-derived tick and cursor labels on both value axes. */
  formatAxisValue?: (value: number, domain: CompositeAxisDomain) => string;
  xAxis?: CompositeChartXAxis;
  /** Tagged onto the plot's semantic node so remote clients can find this chart. */
  remoteKind?: string;
  /** Permit panning into an older unloaded window so the owner can backfill it. */
  allowHistoricalBackfill?: boolean;
  cursorDate?: Date | null;
  viewport?: {
    start: Date;
    end: Date;
  };
  /**
   * Stable identity for the authored viewport. Changing it resets user navigation;
   * viewport updates under the same key are treated as adaptive data refreshes.
   */
  viewportResetKey?: string;
  colors?: Partial<CompositeChartColors>;
  axisWidth?: number;
  showLegend?: boolean;
  /** Show the regular-session percentage beside latest eligible legend values. */
  showLatestChangePercent?: boolean;
  legendAccessory?: ReactNode;
  legendAccessoryWidth?: number;
  showTimeAxis?: boolean;
  emptyMessage?: string;
  formatValue?: (value: number, series: ResolvedSeries) => string;
  onCursorDateChange?: (date: Date | null) => void;
  /** Reports a user-created viewport, or null when the user resets to the authored viewport. */
  onViewportChange?: (
    viewport: { start: Date; end: Date } | null,
    interaction: "pan" | "reset" | "zoom",
  ) => void;
  onActivate?: () => void;
  onToggleSeries?: (seriesId: string) => void;
  isSeriesToggleable?: (series: ResolvedSeries) => boolean;
}
