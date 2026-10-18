import type { ReactNode } from "react";
import type { CompositeChartLevels } from "./levels";
import type { SeriesLineCue } from "./series-cues";
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
  /** Each source's price category, retained when different assets share an axis. */
  priceAssetCategories?: string[];
  /** The reference price of the axis's first market series of each price
   * category (keyed by category, "" for none). It sets the decimals of the
   * cursor and last-price labels, so they do not follow the live value. */
  priceReferences?: Record<string, number>;
  seriesIds: string[];
  /** Most labeled ticks the axis shows, sized to the panel height. */
  maxTicks?: number;
  /** Rows the labels snap to, one per row, in the terminal. Unset where labels
   * sit at their exact heights. */
  tickRows?: number;
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

interface CompositeCalendarTimeScale {
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

interface CompositeMarketTimeScale {
  kind: "market";
  startTime: number;
  endTime: number;
  anchorSeriesId: string;
  cadenceMs: number;
  /**
   * Wall-clock time one slot stands for before the first observation: the
   * loaded bars' own average, closed sessions included. Absent means
   * `cadenceMs`.
   */
  historyMsPerSlot?: number;
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
interface CompositeLastPriceMarker {
  seriesId: string;
  color: string;
  axis: CompositeAxisSide;
  value: number;
  yRatio: number;
}

/**
 * A run of extended-hours bars on the plot, as x ratios, and whether a
 * regular-session bar lies on each side of it.
 */
export interface CompositeExtendedHoursSpan {
  start: number;
  end: number;
  startsAfterBar: boolean;
  endsBeforeBar: boolean;
}

/** Volume traded at each price over the bars in view, drawn against the right edge. */
export interface CompositeVolumeProfile {
  seriesId: string;
  color: string;
  /** Lowest price first; ratios run down the plot, so `lowRatio` is the larger. */
  rows: Array<{ lowRatio: number; highRatio: number; volume: number; valueArea: boolean }>;
  maxVolume: number;
  /** Point of control: the middle of the busiest row. */
  poc: number;
  pocRatio: number;
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
  /** Present on a panel holding a volume-profile study. */
  volumeProfile?: CompositeVolumeProfile;
  /** Plot spans (x ratios) of intraday bars outside the regular session, shared by every panel. */
  extendedHours?: readonly CompositeExtendedHoursSpan[];
  /** The previous session's close on a one-day chart, drawn as a dotted reference line. */
  priorClose?: { axis: CompositeAxisSide; value: number; yRatio: number };
  /** How each line tells itself apart besides colour, by series id; absent on a chart with one line. */
  lineCues?: ReadonlyMap<string, SeriesLineCue>;
}

export interface CompositeCursorValue {
  seriesId: string;
  label: string;
  color: string;
  unit: string;
  value: number | null;
  point: TimeSeriesPoint | null;
  /**
   * Under a cursor, the value is the series' last one before the cursor's
   * time, which it has no observation at: another venue's hours, a coarser
   * cadence, a dataset that lags.
   */
  carried?: boolean;
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
  /**
   * The panels before they were thinned to the plot's pixels, which the
   * cursor reads values from: a thinned line or a bucket of candles has no
   * point at most of the bars it stands for.
   */
  cursorPanels?: CompositePanelScene[];
  /** IANA zone the time axis and cursor read in: the venue's for intraday market bars, else UTC. */
  timeZone?: string;
  /** The newest observation's time, in view or not. */
  newestTime?: number;
}

export interface BuildCompositeChartSceneOptions {
  width: number;
  height: number;
  cursorDate?: Date | null;
  viewport?: {
    start: Date;
    end: Date;
  };
  /** Keep displayed observations and cursor dates inside the active window. */
  clipToViewport?: boolean;
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
  /** Labels positioned on a numeric domain rather than evenly spread. */
  ticks?: readonly { label: string; ratio: number }[];
  /** Vertical guide lines through the plot, captioned below the axis. */
  markers?: readonly CompositeChartXMarker[];
  formatCursor?: (xRatio: number) => string;
}

/**
 * A crosshair shared between charts, as the last instant of the bar it is
 * on. The chart subscribes itself, so a move re-renders the charts and not
 * the panes around them.
 */
interface CompositeCursorLink {
  subscribe(listener: () => void): () => void;
  /**
   * Another chart's cursor, shown in place of this chart's own: on the last
   * bar at or before it, and not at all outside the view. Null while this
   * chart's cursor is the shared one, or there is none.
   */
  time(): number | null;
  /** Whether this chart's cursor is the shared one. */
  held(): boolean;
  /** Reports this chart's cursor, or null when it leaves. */
  publish(time: number | null): void;
  /** Clears the shared cursor wherever it is, as Esc on a chart showing it does. */
  clear(): void;
  /** Whether the shared cursor is pinned; a link without pins never is. */
  pinned?(): boolean;
  /** Pins the shared cursor at a time no pointer moves, or unpins it with null. */
  pin?(time: number | null): void;
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
  /**
   * The chart takes its keys: Left/Right move the cursor and Esc clears it,
   * [ ] and Space reach the legend, and a navigable chart adds pan, zoom and
   * the tools.
   */
  focused?: boolean;
  interactive?: boolean;
  /** False keeps the hover and keyboard cursor but removes pan, zoom, tools, and their keys. */
  navigable?: boolean;
  /** Overrides the unit-derived tick and cursor labels on both value axes. */
  formatAxisValue?: (value: number, domain: CompositeAxisDomain) => string;
  xAxis?: CompositeChartXAxis;
  /** Tagged onto the plot's semantic node so remote clients can find this chart. */
  remoteKind?: string;
  /** Permit panning into an older unloaded window so the owner can backfill it. */
  allowHistoricalBackfill?: boolean;
  cursorDate?: Date | null;
  /**
   * A crosshair shared with other charts. By default an interactive chart
   * with a time axis in a pane shares its layout tab's; null keeps it out.
   */
  cursorLink?: CompositeCursorLink | null;
  viewport?: {
    start: Date;
    end: Date;
  };
  /** An explicit research window bounds marks and hover, including right padding. */
  clipToViewport?: boolean;
  /**
   * Stable identity for the authored viewport. Changing it resets user navigation;
   * viewport updates under the same key are treated as adaptive data refreshes.
   */
  viewportResetKey?: string;
  colors?: Partial<CompositeChartColors>;
  /** Tick gutter budget. Cursor values can widen it; zero hides both axes. */
  axisWidth?: number;
  showLegend?: boolean;
  /** Show the regular-session percentage beside latest eligible legend values. */
  showLatestChangePercent?: boolean;
  legendAccessory?: ReactNode;
  legendAccessoryWidth?: number;
  showTimeAxis?: boolean;
  emptyMessage?: string;
  /** A second, quieter line under `emptyMessage`: what to do about it. */
  emptyDetail?: string;
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
  /**
   * Picks a bar instead of panning: a press on the plot, or Enter at the
   * keyboard cursor, hands back that bar's date; Esc cancels. `label` is the
   * Enter hint, such as "anchor here".
   */
  timePick?: { label: string; onPick: (date: Date) => void; onCancel: () => void } | null;
  /**
   * Horizontal price levels on one series' panel. With `onEdit` the level
   * tool (Shift+H) adds, moves and deletes them by mouse and keyboard.
   */
  levels?: CompositeChartLevels | null;
}
