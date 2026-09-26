import { usePaneArrowsClaimed } from "../../layout/pane/footer/registration";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AsciiText,
  Box,
  ChartSurface,
  ScrollBox,
  Text,
  useNativeRenderer,
  useUiCapabilities,
  useUiHost,
  type BoxRenderable,
  type ChartSurfaceProps,
  type ScrollBoxRenderable,
} from "../../../ui";
import { useShortcut } from "../../../react/input";
import { usePaneFooter } from "../../layout/pane/footer/registration";
import type { PaneHint } from "../../layout/pane/footer/model";
import type { ContextMenuItem } from "../../../types/context-menu";
import { useOptionalPaneInstanceId, usePaneSettingValue } from "../../../state/app/context";
import { colors as themeColors, hoverBg } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { CANONICAL_EXCHANGE_ALIASES } from "../../../utils/exchanges";
import { displayWidth, formatPercentRaw, truncateToDisplayWidth } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { CHART_WATERMARK_ROLE } from "../../../utils/screenshot-watermark";
import type { ResolvedSeries } from "../../../time-series/types";
import { downsampleCompositeChartScene } from "./downsample";
import { reuseResolvedSeriesList } from "./panel-series";
import {
  consumeChartMouseEvent,
  getGlobalMouseX,
  getLocalPlotPointer,
  type ChartMouseEvent,
} from "../core/pointer";
import type { NativeChartBitmap } from "../native/chart-rasterizer";
import { useShowChartTextFallback } from "../native/use-chart-text-fallback";
import {
  useStaticChartBitmapSize,
  type StaticChartBitmapSize,
} from "./bitmap";
import {
  StaticXAxisLabels,
  StaticXMarkerLabels,
  StaticXMarkerOverlay,
} from "./axis-overlays";
import { PriceAxisLabels } from "./price-axis-labels";
import {
  compositeAxisTicks,
  formatCompositeAxisValue,
  formatCompositeCursorDate,
  formatCompositeCursorValue,
  formatCompositePointDetails,
  formatCompositeSeriesValue,
  seriesPriceReference,
  formatCompositeTimeAxisDate,
  type CompositeAxisValueFormatter,
} from "./format";
import {
  COMPOSITE_KEYBOARD_PAN_RATIO,
  COMPOSITE_ZOOM_STEP_FACTOR,
  buildCompositeNavigationFrame,
  compositeNavigationDataViewport,
  compositeViewportPositions,
  fitCompositeViewport,
  panCompositeViewport,
  resolveCompositeChartInteraction,
  resolveCompositeWheelPan,
  resolveCompositeWheelZoom,
  sameCompositeViewport,
  shouldResetCompositeViewport,
  zoomCompositeViewport,
  type CompositeNavigationFrame,
  type CompositeViewportRange,
} from "./interactions";
import { buildCompositeColumnLayout, type CompositeColumnLayout } from "./column-layout";
import { renderCompositePanelBitmap } from "./rasterizer";
import {
  buildChartToolVectors,
  CHART_DRAWING_COLORS,
  CHART_DRAWINGS_SETTING_KEY,
  countMeasureBars,
  drawChartToolOverlay,
  resolveChartToolKind,
  resolveMeasureAxisDomain,
  resolveMeasureDirection,
  resolveMeasureValueAt,
  resolveZoomTimeRange,
  hitTestDrawings,
  isDrawingTool,
  nextDrawingColor,
  parseChartDrawings,
  resolveDrawingFromDrag,
  resolveZoomBoxRange,
  shiftDrawing,
  summarizeMeasure,
  summarizeZoomRange,
  summarizeZoomSelection,
  type ChartDrawing,
  type ChartDrawingPoint,
  type ChartToolDrag,
  type ChartToolKind,
} from "./tools";
import {
  COMPOSITE_RIGHT_OFFSET_RATIO,
  compositeRightOffsetRatio,
  projectCompositeTimestamp,
  unprojectCompositeTimestamp,
} from "./time-scale";
import {
  allocateCompositePanelHeights,
  applyCompositeChartCursor,
  buildCompositeChartScene,
  projectCompositeValue,
  resizeCompositePanel,
  resolveAdjacentCompositeCursorDate,
  resolveCompositeCursorDate,
  unprojectCompositeValue,
} from "./scene";
import {
  compositeAxisTickLabels,
  renderCompositeAxisText,
  renderCompositePanelText,
} from "./text-renderer";
import {
  buildCompositeTimeAxisLayout,
  buildCompositeViewportTimeAxisLayout,
} from "./time-axis";
import type {
  CompositeAxisDomain,
  CompositeChartColors,
  CompositeChartProps,
  CompositeChartScene,
  CompositeChartXMarker,
  CompositePanelScene,
} from "./types";

// A short resize-only delay coalesces geometry churn without delaying
// live-data paints or depending on a foreground animation frame.
const DESKTOP_BITMAP_RESIZE_DEBOUNCE_MS = 32;
const LEGEND_WHEEL_DELTA_PER_CELL = 8;
/** How far past the first loaded observation a backfilling chart may pan, as a fraction of the view. */
const HISTORICAL_PADDING_RATIO = 0.5;

function isVerticalWheelDirection(
  direction: "up" | "down" | "left" | "right",
): direction is "up" | "down" {
  return direction === "up" || direction === "down";
}

interface PanGesture {
  kind: "pan";
  startGlobalX: number;
  frame: CompositeNavigationFrame;
  startViewport: CompositeViewportRange;
  positionsPerCell: number;
}

/**
 * A drag pans in the frame it started in; see `CompositeNavigationFrame`. The
 * plot covers the viewport plus its reserved right offset, so a cell is worth
 * that much time and the bars keep pace with the pointer.
 */
function startPanGesture(
  frame: CompositeNavigationFrame,
  viewport: CompositeViewportRange,
  plotWidth: number,
  globalX: number,
  plotSpanFactor: number,
): PanGesture {
  const positions = compositeViewportPositions(frame, viewport);
  const span = positions ? Math.max(positions.end - positions.start, Number.EPSILON) : 1;
  return {
    kind: "pan",
    startGlobalX: globalX,
    frame,
    startViewport: viewport,
    positionsPerCell: span * plotSpanFactor / Math.max(plotWidth, 1),
  };
}

interface PendingWheel {
  /** Fraction of the visible span, positive toward older observations. */
  panRatio: number;
  zoomLog: number;
  anchorRatio: number;
}

const webFrame = globalThis as typeof globalThis & {
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

function renderPanelBitmap(
  panel: CompositePanelScene,
  bitmapSize: StaticChartBitmapSize,
  colors: CompositeChartColors,
  snapGridToRows = false,
): NativeChartBitmap {
  return renderCompositePanelBitmap(panel, {
    pixelWidth: bitmapSize.pixelWidth,
    pixelHeight: bitmapSize.pixelHeight,
    colors,
    snapGridToRows,
  });
}

function useCompositePanelBitmap({
  panel,
  bitmapSize,
  colors,
  isDesktopWeb,
}: {
  panel: CompositePanelScene;
  bitmapSize: StaticChartBitmapSize | null;
  colors: CompositeChartColors;
  isDesktopWeb: boolean;
}): NativeChartBitmap | null {
  const [desktopBitmap, setDesktopBitmap] = useState<NativeChartBitmap | null>(null);
  const desktopBitmapRef = useRef<NativeChartBitmap | null>(null);
  const desktopRenderInputRef = useRef<{
    panel: CompositePanelScene;
    pixelWidth: number;
    pixelHeight: number;
    colors: CompositeChartColors;
  } | null>(null);
  const desktopRequestedSizeRef = useRef<{ pixelWidth: number; pixelHeight: number } | null>(null);
  const desktopRenderedSizeRef = useRef<{ pixelWidth: number; pixelHeight: number } | null>(null);
  const desktopRenderTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const desktopActiveRef = useRef(false);
  const pixelWidth = bitmapSize?.pixelWidth ?? null;
  const pixelHeight = bitmapSize?.pixelHeight ?? null;

  desktopRenderInputRef.current = isDesktopWeb && pixelWidth !== null && pixelHeight !== null
    ? { panel, pixelWidth, pixelHeight, colors }
    : null;

  // The cursor is drawn as a separate overlay, so the plot raster stays cached
  // (and resident in the terminal) while the crosshair moves.
  const terminalBitmap = useMemo(() => {
    if (isDesktopWeb || !bitmapSize) return null;
    return renderPanelBitmap(panel, bitmapSize, colors, true);
  }, [bitmapSize, colors, isDesktopWeb, panel]);

  useEffect(() => {
    const cancelRender = () => {
      if (desktopRenderTimerRef.current === null) return;
      clearTimeout(desktopRenderTimerRef.current);
      desktopRenderTimerRef.current = null;
    };
    const scheduleRender = (delay: number) => {
      if (desktopRenderTimerRef.current !== null) return;
      desktopRenderTimerRef.current = globalThis.setTimeout(() => {
        desktopRenderTimerRef.current = null;
        if (!desktopActiveRef.current) return;
        const input = desktopRenderInputRef.current;
        if (!input) return;
        const next = renderPanelBitmap(
          input.panel,
          { pixelWidth: input.pixelWidth, pixelHeight: input.pixelHeight },
          input.colors,
        );
        if (!desktopActiveRef.current) return;
        desktopRenderedSizeRef.current = {
          pixelWidth: input.pixelWidth,
          pixelHeight: input.pixelHeight,
        };
        desktopBitmapRef.current = next;
        setDesktopBitmap(next);
      }, delay);
    };

    if (!isDesktopWeb) {
      desktopActiveRef.current = false;
      cancelRender();
      desktopRequestedSizeRef.current = null;
      desktopRenderedSizeRef.current = null;
      return;
    }
    if (pixelWidth === null || pixelHeight === null) {
      desktopActiveRef.current = false;
      cancelRender();
      desktopRequestedSizeRef.current = null;
      desktopRenderedSizeRef.current = null;
      desktopBitmapRef.current = null;
      setDesktopBitmap((current) => current === null ? current : null);
      return;
    }

    desktopActiveRef.current = true;
    const nextSize = { pixelWidth, pixelHeight };
    const requestedSize = desktopRequestedSizeRef.current;
    const requestedSizeChanged = !requestedSize
      || requestedSize.pixelWidth !== pixelWidth
      || requestedSize.pixelHeight !== pixelHeight;
    desktopRequestedSizeRef.current = nextSize;
    const renderedSize = desktopRenderedSizeRef.current;
    const sizeAlreadyRendered = !!renderedSize
      && renderedSize.pixelWidth === pixelWidth
      && renderedSize.pixelHeight === pixelHeight;

    if (!desktopBitmapRef.current || sizeAlreadyRendered) {
      if (requestedSizeChanged) cancelRender();
      scheduleRender(0);
      return;
    }

    if (!requestedSizeChanged || desktopRenderTimerRef.current !== null) return;
    scheduleRender(DESKTOP_BITMAP_RESIZE_DEBOUNCE_MS);
  }, [colors, isDesktopWeb, panel, pixelHeight, pixelWidth]);

  useEffect(() => () => {
    desktopActiveRef.current = false;
    if (desktopRenderTimerRef.current !== null) {
      clearTimeout(desktopRenderTimerRef.current);
      desktopRenderTimerRef.current = null;
    }
  }, []);

  if (!bitmapSize) return null;
  return isDesktopWeb ? desktopBitmap : terminalBitmap;
}

function resolvePanelCrosshair(
  panel: CompositePanelScene,
  columnLayout: CompositeColumnLayout,
  bitmap: NativeChartBitmap | null,
  cursorXRatio: number | null,
  cursorYRatio: number | null,
  color: string,
): ChartSurfaceProps["crosshair"] {
  if (!bitmap || cursorXRatio === null) return null;
  const markers = panel.series.flatMap((series) => {
    // Column cohorts are drawn at their group center, not each observation's
    // own timestamp, so match the position the bar actually occupies.
    const cursorPoint = series.points.find((point) => {
      const xRatio = series.source.style === "columns"
        ? columnLayout.groupByPoint.get(point)?.xRatio ?? point.xRatio
        : point.xRatio;
      return Math.abs(xRatio - cursorXRatio) < 1e-9;
    });
    return cursorPoint
      ? [{
        pixelY: cursorPoint.yRatio * Math.max(bitmap.height - 1, 0),
        color: series.source.color,
      }]
      : [];
  });
  return {
    pixelX: cursorXRatio * Math.max(bitmap.width - 1, 0),
    pixelY: cursorYRatio === null ? null : cursorYRatio * Math.max(bitmap.height - 1, 0),
    color,
    markers,
  };
}

function axisLabelRows(lines: string[]): ReadonlyMap<number, string> {
  return new Map(lines.flatMap((line, row) => {
    const label = line.trim();
    return label ? [[row, label] as const] : [];
  }));
}

function cursorAxisLabel(
  panel: CompositePanelScene,
  side: "left" | "right",
  cursorYRatio: number | null,
  format?: CompositeAxisValueFormatter,
): string | null {
  const domain = panel.axes[side];
  if (!domain || cursorYRatio === null) return null;
  const value = unprojectCompositeValue(cursorYRatio, domain);
  if (value === null) return null;
  return format ? format(value, domain) : formatCompositeCursorValue(value, domain);
}

const MINIMUM_AXIS_LABEL_WIDTH = 3;

/**
 * Reserve cursor precision even when the tick values are round numbers. This
 * keeps the plot stable while the pointer moves between integer tick values.
 */
function compositeAxisLabelWidth(
  domain: CompositeAxisDomain | undefined,
  format: CompositeAxisValueFormatter | undefined,
  includeCursor: boolean,
): number {
  if (!domain) return 0;
  const ticks = compositeAxisTicks(domain, format);
  const labels = ticks.map((tick) => tick.label);
  if (includeCursor) {
    const cursorFormat = format ?? formatCompositeCursorValue;
    for (const { value } of ticks) {
      labels.push(cursorFormat(value, domain));
      // Totals use two decimals at their compact scale; prices can use four
      // below one currency unit. Probe those digits without changing the data.
      const scale = domain.unitGroup.toLowerCase().split(":")[0] === "currency-total"
        ? 10 ** Math.max(0, Math.min(12, Math.floor(Math.log10(Math.abs(value) || 1) / 3) * 3))
        : Math.abs(value) > 0 && Math.abs(value) < 0.01
          ? 10 ** Math.floor(Math.log10(Math.abs(value))) : 1;
      const precisionValue = (value < 0 ? -1 : 1) * (Math.floor(Math.abs(value) / scale) + 0.1234) * scale;
      labels.push(cursorFormat(precisionValue, domain));
    }
  }
  return labels.reduce((widest, label) => Math.max(widest, [...label].length), 0);
}


const HAND_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M6.4 8V3.5a1.15 1.15 0 0 1 2.3 0V7m0-.6a1.15 1.15 0 0 1 2.3 0V8m0-.5a1.15 1.15 0 0 1 2.3 0v3.1c0 2.1-1.7 3.8-3.8 3.8H8.9c-1.2 0-2.3-.6-3-1.6L3.6 9.4a1.15 1.15 0 0 1 1.8-1.4L6.4 9.2" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const RULER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1.4" y="4.6" width="13.2" height="6.8" rx="1.4" fill="none" stroke="#000" stroke-width="1.4"/><path d="M5 4.6v2.6M8 4.6v3.6M11 4.6v2.6" stroke="#000" stroke-width="1.3" stroke-linecap="round"/></svg>`;
const PEN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2.4 13.6 4 9.9 10.6 3.3a1.6 1.6 0 0 1 2.3 0l0 0a1.6 1.6 0 0 1 0 2.3L6.2 12 2.4 13.6Z" fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
const LINE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M3.2 12.8 12.8 3.2" stroke="#000" stroke-width="1.6" stroke-linecap="round"/><circle cx="3.2" cy="12.8" r="2" fill="none" stroke="#000" stroke-width="1.4"/><circle cx="12.8" cy="3.2" r="2" fill="none" stroke="#000" stroke-width="1.4"/></svg>`;
const MARQUEE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2.2 6V3.4a1.2 1.2 0 0 1 1.2-1.2H6M10 2.2h2.6a1.2 1.2 0 0 1 1.2 1.2V6M13.8 10v2.6a1.2 1.2 0 0 1-1.2 1.2H10M6 13.8H3.4a1.2 1.2 0 0 1-1.2-1.2V10" fill="none" stroke="#000" stroke-width="1.7" stroke-linecap="round"/></svg>`;

const CHART_TOOLS: ReadonlyArray<{
  /** null is the resting state: the pointer pans and nothing is armed. */
  kind: ChartToolKind | null;
  label: string;
  shortcut: string;
  hint: string;
  glyph: string;
  icon: string;
}> = [
  {
    kind: null,
    label: "Pan",
    shortcut: "Esc",
    hint: "Drag to move through time, the resting state of the pointer",
    glyph: "\u2725",
    icon: HAND_ICON,
  },
  {
    kind: "measure",
    label: "Ruler",
    shortcut: "Shift+M",
    hint: "Drag to measure change, percent, bars, and elapsed time",
    glyph: "\u2194",
    icon: RULER_ICON,
  },
  {
    kind: "zoom",
    label: "Zoom to range",
    shortcut: "Shift+Z",
    hint: "Drag to select a time range to zoom into",
    glyph: "\u229e",
    icon: MARQUEE_ICON,
  },
  {
    kind: "line",
    label: "Trend line",
    shortcut: "Shift+D",
    hint: "Drag a straight line, grab an end to reshape it, Backspace deletes",
    glyph: "\u2571",
    icon: LINE_ICON,
  },
  {
    kind: "pencil",
    label: "Freehand",
    shortcut: "Shift+P",
    hint: "Draw freehand, drag a shape to move it, Backspace deletes",
    glyph: "\u223f",
    icon: PEN_ICON,
  },
];

interface ChartToolSpan {
  startXRatio: number;
  endXRatio: number;
  /** The anchor's own time, which can sit outside the view once it pans. */
  startTime: number;
  color: string;
}

/** Pane menu names for the tools, with the keys that pick them. */
const CHART_TOOL_MENU: ReadonlyArray<{ kind: ChartToolKind; label: string; accelerator: string }> = [
  { kind: "measure", label: "Ruler", accelerator: "Shift+M" },
  { kind: "zoom", label: "Zoom to Range", accelerator: "Shift+Z" },
  { kind: "line", label: "Trend Line", accelerator: "Shift+D" },
  { kind: "pencil", label: "Freehand", accelerator: "Shift+P" },
];

/** What Enter does next with a tool in hand, for the footer and the pane menu. */
const KEYBOARD_TOOL_HINTS: Record<ChartToolKind, {
  start: string;
  startTitle: string;
  finish: string;
  finishTitle: string;
}> = {
  measure: { start: "measure", startTitle: "Start Measure", finish: "done", finishTitle: "Finish Measure" },
  zoom: { start: "select", startTitle: "Select Range", finish: "zoom", finishTitle: "Zoom to Range" },
  line: { start: "draw", startTitle: "Draw Line", finish: "place", finishTitle: "Place Line" },
  pencil: { start: "draw", startTitle: "Draw Freehand", finish: "place", finishTitle: "Place Drawing" },
};

/**
 * A tool placed from the keyboard: Enter anchors it at the cursor, the arrows
 * move its end and Enter finishes it. Held in data, so a pan, a zoom or a new
 * bar leaves it on the observations it was placed on.
 */
interface KeyboardToolPlacement {
  kind: ChartToolKind;
  panelId: string;
  start: ChartDrawingPoint;
  end: ChartDrawingPoint;
  /** Every step the end took: the freehand tool's trail. */
  path: ChartDrawingPoint[];
  /** Up or Down set the end's level, so Left and Right stop following the series. */
  freeValue: boolean;
}

/** A keyboard placement projected into the plot of the panel that holds it. */
interface KeyboardToolDrag {
  panelId: string;
  drag: ChartToolDrag;
  start: ChartDrawingPoint;
  end: ChartDrawingPoint;
}

const ARMED_TOOL_BY_INTERACTION = {
  "arm-measure": "measure",
  "arm-zoom": "zoom",
  "arm-line": "line",
  "arm-pencil": "pencil",
} as const satisfies Record<string, ChartToolKind>;

const COMPOSITE_PANEL_ROLE = "composite-chart-panel";

// Wordmark cell grid at scale 1 (27 columns of 8px, 4 rows of 12px).
const WATERMARK_BASE_WIDTH_PX = 216;
const WATERMARK_BASE_HEIGHT_PX = 48;

/**
 * Size the screenshot wordmark to roughly half the plot width, capped so it
 * stays a mark rather than a poster. Plots too small for a legible mark get
 * none: a clipped wordmark reads as a glitch.
 */
export function chartWatermarkScale(plotWidthPx: number, plotHeightPx: number): number | null {
  const scale = Math.min(
    (plotWidthPx * 0.5) / WATERMARK_BASE_WIDTH_PX,
    (plotHeightPx * 0.4) / WATERMARK_BASE_HEIGHT_PX,
    3,
  );
  return scale >= 1 ? Math.round(scale * 4) / 4 : null;
}

let nextDrawingSequence = 1;

function nextDrawingId(): string {
  return `drawing:${nextDrawingSequence++}`;
}

/** Icon cells plus the gap between chips. */
const CHART_TOOLBAR_WIDTH = CHART_TOOLS.length * 3 + (CHART_TOOLS.length - 1);

function ChartToolChip({
  tool,
  active,
  isDesktopWeb,
  onPress,
}: {
  tool: (typeof CHART_TOOLS)[number];
  active: boolean;
  isDesktopWeb: boolean;
  onPress: () => void;
}) {
  const label = `${tool.label} (${tool.shortcut}). ${tool.hint}`;
  const color = active ? themeColors.text : themeColors.textDim;
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      width={3}
      height={1}
      flexShrink={0}
      backgroundColor={active ? themeColors.selected : undefined}
      hoverBackgroundColor={hoverBg()}
      onMouseDown={(event: ChartMouseEvent) => {
        consumeChartMouseEvent(event);
        onPress();
      }}
      cursor="pointer"
      data-gloom-interactive="true"
      data-gloom-role="composite-chart-tool"
      data-gloom-label={label}
      data-active={active ? "true" : "false"}
      title={isDesktopWeb ? label : undefined}
      // Cells size the terminal strip; the desktop chip sizes to its icon.
      style={isDesktopWeb ? { width: "auto", paddingInline: 4, borderRadius: 4 } : undefined}
    >
      {isDesktopWeb ? (
        <Box
          flexShrink={0}
          style={{
            width: 13,
            height: 13,
            backgroundColor: color,
            maskImage: svgMaskUrl(tool.icon),
            WebkitMaskImage: svgMaskUrl(tool.icon),
            maskSize: "contain",
            WebkitMaskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
          }}
        />
      ) : (
        <Text fg={color}>{tool.glyph}</Text>
      )}
    </Box>
  );
}


/** Blurs a focused text field, the focus change a consumed mousedown prevents. */
function releaseEditableFocus(event: ChartMouseEvent): void {
  if (!event.target?.closest?.(`[data-gloom-role="${COMPOSITE_PANEL_ROLE}"]`)) return;
  const active = (globalThis as {
    document?: { activeElement?: { tagName?: string; blur?: () => void } };
  }).document?.activeElement;
  const tag = active?.tagName?.toUpperCase();
  if (tag !== "INPUT" && tag !== "TEXTAREA") return;
  active?.blur?.();
}

function svgMaskUrl(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function ChartColorSwatch({
  color,
  active,
  isDesktopWeb,
  onPress,
}: {
  color: string;
  active: boolean;
  isDesktopWeb: boolean;
  onPress: () => void;
}) {
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      width={2}
      height={1}
      flexShrink={0}
      backgroundColor={active ? themeColors.selected : undefined}
      hoverBackgroundColor={hoverBg()}
      onMouseDown={(event: ChartMouseEvent) => {
        consumeChartMouseEvent(event);
        onPress();
      }}
      cursor="pointer"
      data-gloom-interactive="true"
      data-gloom-role="composite-chart-color"
      data-gloom-label={`Drawing colour ${color}`}
      data-active={active ? "true" : "false"}
      style={isDesktopWeb
        ? {
          width: 14,
          height: 14,
          borderRadius: 999,
          backgroundColor: color,
          border: `1.5px solid ${active ? themeColors.text : "transparent"}`,
        }
        : undefined}
    >
      {isDesktopWeb ? null : <Text fg={color}>{active ? "\u25c9" : "\u25cf"}</Text>}
    </Box>
  );
}

function ChartToolbar({
  armedTool,
  isDesktopWeb,
  left,
  top,
  drawColor,
  showColors,
  onArmTool,
  onPickColor,
}: {
  armedTool: ChartToolKind | null;
  isDesktopWeb: boolean;
  left: number;
  top: number;
  drawColor: string;
  showColors: boolean;
  onArmTool: (tool: ChartToolKind | null) => void;
  onPickColor: (color: string) => void;
}) {
  return (
    <Box
      position="absolute"
      left={left}
      top={top}
      height={1}
      flexDirection="row"
      gap={1}
      zIndex={30}
      backgroundColor={themeColors.bg}
      style={isDesktopWeb
        ? {
          gap: 3,
          padding: 3,
          borderRadius: 7,
          backgroundColor: `color-mix(in srgb, ${themeColors.bg} 78%, transparent)`,
          backdropFilter: "blur(6px)",
          width: "auto",
          height: "auto",
        }
        : undefined}
      data-gloom-role="composite-chart-toolbar"
    >
      {CHART_TOOLS.map((tool) => (
        <ChartToolChip
          key={tool.kind ?? "pan"}
          tool={tool}
          active={armedTool === tool.kind}
          isDesktopWeb={isDesktopWeb}
          onPress={() => onArmTool(tool.kind)}
        />
      ))}
      {/* Colours only take space while something can use them. */}
      {showColors ? CHART_DRAWING_COLORS.map((color) => (
        <ChartColorSwatch
          key={color}
          color={color}
          active={color === drawColor}
          isDesktopWeb={isDesktopWeb}
          onPress={() => onPickColor(color)}
        />
      )) : null}
    </Box>
  );
}

function resolveSeriesCursorYRatio(
  panel: CompositePanelScene,
  scene: CompositeChartScene,
): number | null {
  for (const series of panel.series) {
    const value = scene.cursorValues.find(
      (entry) => entry.seriesId === series.source.id,
    )?.value ?? null;
    const domain = panel.axes[series.source.axis];
    if (value === null || !domain) continue;
    const yRatio = projectCompositeValue(value, domain);
    if (yRatio !== null) return yRatio;
  }
  return null;
}

interface CompositePanelSurfaceProps {
  panel: CompositePanelScene;
  scene: CompositeChartScene;
  plotWidth: number;
  leftAxisWidth: number;
  rightAxisWidth: number;
  axisGap: number;
  colors: CompositeChartColors;
  interactive: boolean;
  /** False keeps the hover cursor but removes pan, zoom, and the tools. */
  navigable: boolean;
  formatAxisValue?: CompositeAxisValueFormatter;
  remoteKind?: string;
  viewport: CompositeViewportRange;
  frame: CompositeNavigationFrame;
  armedTool: ChartToolKind | null;
  drawings: readonly ChartDrawing[];
  selectedDrawingId: string | null;
  drawColor: string;
  onDraw: (drawing: ChartDrawing) => void;
  onEditDrawing: (id: string, update: (drawing: ChartDrawing) => ChartDrawing) => void;
  onSelectDrawing: (id: string | null) => void;
  onActivate?: () => void;
  onCursorDateChange: (date: Date | null) => void;
  /** Positive positions move toward older observations. A gesture supplies the frame and origin it started from. */
  onPanViewport: (
    deltaPositions: number,
    gesture?: { frame: CompositeNavigationFrame; from: CompositeViewportRange },
  ) => void;
  onZoomViewport: (zoomFactor: number, anchorRatio: number) => void;
  onSetViewport: (range: CompositeViewportRange) => void;
  onToolSpanChange: (span: ChartToolSpan | null) => void;
  /** The tool being placed from the keyboard, when it lives in this panel. */
  keyboardToolDrag: KeyboardToolDrag | null;
  /** A press on the plot: the pointer takes over from a keyboard placement. */
  onPointerPress: () => void;
  showTextFallback: boolean;
}

function CompositePanelSurface({
  panel,
  scene,
  plotWidth,
  leftAxisWidth,
  rightAxisWidth,
  axisGap,
  colors,
  interactive,
  navigable,
  formatAxisValue,
  remoteKind,
  viewport,
  frame,
  armedTool,
  drawings,
  selectedDrawingId,
  drawColor,
  onDraw,
  onEditDrawing,
  onSelectDrawing,
  onActivate,
  onCursorDateChange,
  onPanViewport,
  onZoomViewport,
  onSetViewport,
  onToolSpanChange,
  keyboardToolDrag,
  onPointerPress,
  showTextFallback,
}: CompositePanelSurfaceProps) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const { cellHeightPx = 18, cellWidthPx = 8 } = useUiCapabilities();
  const renderer = useNativeRenderer();
  const plotRef = useRef<BoxRenderable | null>(null);
  const [cursorYRatio, setCursorYRatio] = useState<number | null>(null);
  const [toolDrag, setToolDrag] = useState<ChartToolDrag | null>(null);
  // A pointer drag owns the plot while it lasts; otherwise a tool placed from
  // the keyboard draws and reads out exactly like one.
  const keyboardDrag = toolDrag ? null : keyboardToolDrag;
  const activeDrag = toolDrag ?? keyboardDrag?.drag ?? null;
  // A keyboard placement's end sits at the level the user put it, so it
  // draws a level line where otherwise only the pointer would.
  const heldCursorYRatio = keyboardDrag ? keyboardDrag.drag.endYRatio : cursorYRatio;
  const seriesCursorYRatio = useMemo(
    () => resolveSeriesCursorYRatio(panel, scene),
    [panel, scene],
  );
  const activeCursorYRatio = scene.cursorXRatio === null
    ? null
    : heldCursorYRatio ?? seriesCursorYRatio;
  const dragRef = useRef<
    | PanGesture
    | {
      kind: "edit";
      drawingId: string;
      pointIndex: number | null;
      lastXRatio: number;
      lastYRatio: number;
    }
    | ChartToolDrag
    | null
  >(null);
  const plotAspect = (plotWidth * cellWidthPx) / Math.max(panel.height * cellHeightPx, 1);
  // The plot is wider than the viewport by the reserved right offset. Gestures
  // read the pointer in plot space, so they convert through this.
  const plotSpanFactor = 1 + compositeRightOffsetRatio(scene.timeScale);
  const bitmapSize = useStaticChartBitmapSize(plotWidth, panel.height);
  const bitmap = useCompositePanelBitmap({ panel, bitmapSize, colors, isDesktopWeb });
  const columnLayout = useMemo(() => buildCompositeColumnLayout(panel), [panel]);
  // The level line follows the pointer only. A keyboard or shared cursor knows
  // its column, and the series markers and axis readout already say the value.
  // A tool placed from the keyboard is the exception: its end is a level.
  const pointerCursorYRatio = scene.cursorXRatio === null ? null : heldCursorYRatio;
  const crosshair = useMemo(
    () => resolvePanelCrosshair(panel, columnLayout, bitmap, scene.cursorXRatio, pointerCursorYRatio, colors.crosshair),
    [bitmap, colors.crosshair, columnLayout, panel, pointerCursorYRatio, scene.cursorXRatio],
  );
  const measureDomain = useMemo(() => resolveMeasureAxisDomain(panel), [panel]);
  const toolReadout = useMemo(() => {
    if (!activeDrag) return null;
    // A keyboard placement knows its data points exactly, even off screen; a
    // pointer drag reads them back from the plot.
    const startTime = keyboardDrag?.start.time
      ?? unprojectCompositeTimestamp(scene.timeScale, activeDrag.startXRatio);
    const endTime = keyboardDrag?.end.time
      ?? unprojectCompositeTimestamp(scene.timeScale, activeDrag.endXRatio);
    if (activeDrag.kind === "zoom") {
      return {
        direction: "up" as const,
        summary: keyboardDrag
          ? summarizeZoomRange(scene, startTime, endTime)
          : summarizeZoomSelection(scene, activeDrag),
        startTime,
        startValueLabel: null,
        endValueLabel: null,
      };
    }
    const startValue = keyboardDrag
      ? keyboardDrag.start.value
      : measureDomain ? unprojectCompositeValue(activeDrag.startYRatio, measureDomain) : null;
    const endValue = keyboardDrag
      ? keyboardDrag.end.value
      : measureDomain ? unprojectCompositeValue(activeDrag.endYRatio, measureDomain) : null;
    return {
      direction: resolveMeasureDirection(startValue, endValue),
      summary: summarizeMeasure({
        startValue,
        endValue,
        startTime,
        endTime,
        // Cross-market cursor stops include every listing's observations;
        // measured bars still follow the primary market's session scale.
        bars: countMeasureBars(scene.timeScale.kind === "market"
          ? scene.timeScale.anchors.map(({ timestamp }) => new Date(timestamp))
          : scene.dates, startTime, endTime),
        domain: measureDomain,
      }),
      startTime,
      startValueLabel: measureDomain && startValue !== null
        ? formatCompositeCursorValue(startValue, measureDomain)
        : null,
      endValueLabel: measureDomain && endValue !== null
        ? formatCompositeCursorValue(endValue, measureDomain)
        : null,
    };
  }, [activeDrag, keyboardDrag, measureDomain, scene]);
  const toolSummary = toolReadout?.summary ?? null;
  const toolStartTime = toolReadout?.startTime ?? null;
  const toolSpan = useMemo(() => {
    if (!activeDrag || !toolSummary || toolStartTime === null) return null;
    return {
      startXRatio: activeDrag.startXRatio,
      endXRatio: activeDrag.endXRatio,
      startTime: toolStartTime,
      color: activeDrag.kind === "zoom"
        ? colors.crosshair
        : toolReadout?.direction === "down" ? colors.negative : themeColors.positive,
    };
  }, [activeDrag, colors.crosshair, colors.negative, toolReadout?.direction, toolStartTime, toolSummary]);
  useEffect(() => {
    onToolSpanChange(toolSpan);
  }, [onToolSpanChange, toolSpan]);
  const panelDrawings = useMemo(
    () => drawings.filter((drawing) => drawing.panelId === panel.id),
    [drawings, panel.id],
  );
  const bitmapLayers = useMemo(() => {
    if (!bitmap) return null;
    // The desktop composites overlays as vectors, so the plot raster stays put
    // while a tool drags. Copying and reblending it per frame is what made the
    // ruler feel heavy.
    if (isDesktopWeb || (!activeDrag && panelDrawings.length === 0)) return [bitmap];
    return [drawChartToolOverlay(
      bitmap,
      activeDrag,
      {
        positive: themeColors.positive,
        negative: colors.negative,
        zoom: colors.crosshair,
        draw: drawColor,
      },
      toolReadout?.direction ?? "up",
      { scene, panel, items: panelDrawings, selectedId: selectedDrawingId },
    )];
  }, [
    activeDrag,
    bitmap,
    colors.crosshair,
    colors.negative,
    drawColor,
    isDesktopWeb,
    panel,
    panelDrawings,
    scene,
    selectedDrawingId,
    toolReadout?.direction,
  ]);
  const vectors = useMemo<ChartSurfaceProps["vectors"]>(() => {
    if (!isDesktopWeb) return null;
    const shapes = buildChartToolVectors({
      scene,
      panel,
      drawings: panelDrawings,
      selectedId: selectedDrawingId,
      drag: activeDrag,
      colors: {
        positive: themeColors.positive,
        negative: colors.negative,
        zoom: colors.crosshair,
        draw: drawColor,
      },
      direction: toolReadout?.direction ?? "up",
    });
    return shapes.length > 0 ? shapes : null;
  }, [
    activeDrag,
    colors.crosshair,
    colors.negative,
    drawColor,
    isDesktopWeb,
    panel,
    panelDrawings,
    scene,
    selectedDrawingId,
    toolReadout?.direction,
  ]);
  const textLines = useMemo(
    () => isDesktopWeb || !showTextFallback
      ? []
      : renderCompositePanelText(panel, plotWidth, scene.cursorXRatio, pointerCursorYRatio),
    [isDesktopWeb, panel, plotWidth, pointerCursorYRatio, scene.cursorXRatio, showTextFallback],
  );
  const leftAxisLabels = useMemo(
    () => axisLabelRows(
      renderCompositeAxisText(panel.axes.left, panel.height, leftAxisWidth, "left", formatAxisValue),
    ),
    [formatAxisValue, leftAxisWidth, panel],
  );
  const rightAxisLabels = useMemo(
    () => axisLabelRows(
      renderCompositeAxisText(panel.axes.right, panel.height, rightAxisWidth, "right", formatAxisValue),
    ),
    [formatAxisValue, panel, rightAxisWidth],
  );
  const leftAxisTicks = useMemo(
    () => compositeAxisTickLabels(panel.axes.left, leftAxisWidth, formatAxisValue),
    [formatAxisValue, leftAxisWidth, panel],
  );
  const rightAxisTicks = useMemo(
    () => compositeAxisTickLabels(panel.axes.right, rightAxisWidth, formatAxisValue),
    [formatAxisValue, panel, rightAxisWidth],
  );
  const cursorRow = activeCursorYRatio === null
    ? null
    : Math.round(activeCursorYRatio * Math.max(panel.height - 1, 0));
  const cursorPixelY = activeCursorYRatio === null
    ? null
    : activeCursorYRatio * Math.max(panel.height * cellHeightPx - 1, 0);
  const leftCursorLabel = cursorAxisLabel(panel, "left", activeCursorYRatio, formatAxisValue);
  const rightCursorLabel = cursorAxisLabel(panel, "right", activeCursorYRatio, formatAxisValue);
  const measureReadout = useMemo(() => {
    if (!activeDrag || !toolReadout?.summary) return null;
    const text = toolReadout.summary;
    const centreX = (activeDrag.startXRatio + activeDrag.endXRatio) / 2;
    const centreY = activeDrag.kind === "zoom"
      ? 0.5
      : (activeDrag.startYRatio + activeDrag.endYRatio) / 2;
    const width = Math.min([...text].length, plotWidth);
    return {
      text,
      width,
      color: activeDrag.kind === "zoom"
        ? colors.text
        : toolReadout.direction === "down" ? colors.negative : themeColors.positive,
      left: leftAxisWidth + (leftAxisWidth ? axisGap : 0)
        + Math.max(0, Math.min(plotWidth - width, Math.round(centreX * plotWidth - width / 2))),
      top: Math.max(0, Math.min(panel.height - 1, Math.round(centreY * (panel.height - 1)))),
    };
  }, [
    activeDrag,
    axisGap,
    colors.negative,
    colors.text,
    leftAxisWidth,
    panel.height,
    plotWidth,
    toolReadout,
  ]);
  const axisMarkers = useMemo(() => {
    // The crosshair already marks the moving end, so the axes only need the
    // anchor the drag started from.
    if (!activeDrag || activeDrag.kind === "zoom" || !toolReadout?.startValueLabel) return null;
    return {
      side: null,
      // A keyboard anchor can leave the value range once the view moves.
      yRatio: Math.max(0, Math.min(1, activeDrag.startYRatio)),
      label: toolReadout.startValueLabel,
      color: toolReadout.direction === "down" ? colors.negative : themeColors.positive,
    };
  }, [activeDrag, colors.negative, toolReadout]);
  const lastPriceMarker = useMemo(() => {
    const marker = panel.lastPrice;
    const domain = marker ? panel.axes[marker.axis] : undefined;
    if (!marker || !domain) return null;
    return {
      side: marker.axis,
      yRatio: marker.yRatio,
      label: formatAxisValue
        ? formatAxisValue(marker.value, domain)
        : formatCompositeCursorValue(marker.value, domain),
      color: marker.color,
    };
  }, [formatAxisValue, panel]);
  const buildAxisMarkers = (side: "left" | "right") => {
    if (!panel.axes[side]) return undefined;
    const markers = [lastPriceMarker, axisMarkers].flatMap((marker) => (
      marker && (marker.side === null || marker.side === side) ? [marker] : []
    ));
    if (markers.length === 0) return undefined;
    return markers.map((marker) => ({
      row: Math.round(marker.yRatio * Math.max(panel.height - 1, 0)),
      pixelY: marker.yRatio * Math.max(panel.height * cellHeightPx - 1, 0),
      label: marker.label,
      color: marker.color,
    }));
  };
  const leftAxisMarkers = buildAxisMarkers("left");
  const rightAxisMarkers = buildAxisMarkers("right");

  const pointerRatios = useCallback((event: ChartMouseEvent) => {
    const pointerTarget = plotRef.current as unknown as Parameters<typeof getLocalPlotPointer>[1];
    const pointer = getLocalPlotPointer(event, pointerTarget, renderer);
    if (!pointer) return null;
    return {
      xRatio: plotWidth <= 1 ? 0 : Math.max(0, Math.min(1, pointer.cellX / (plotWidth - 1))),
      yRatio: panel.height <= 1 ? 0.5 : Math.max(0, Math.min(1, pointer.cellY / (panel.height - 1))),
    };
  }, [panel.height, plotWidth, renderer]);
  const updateCursor = useCallback((event: ChartMouseEvent): boolean => {
    const pointerTarget = plotRef.current as unknown as Parameters<typeof getLocalPlotPointer>[1];
    const pointer = getLocalPlotPointer(event, pointerTarget, renderer);
    if (!pointer) return false;
    const nextDate = resolveCompositeCursorDate(scene, pointer.cellX);
    if (!nextDate) return false;
    const nextYRatio = panel.height <= 1
      ? 0.5
      : Math.max(0, Math.min(1, pointer.cellY / (panel.height - 1)));
    setCursorYRatio((current) => current === nextYRatio ? current : nextYRatio);
    onCursorDateChange(nextDate);
    consumeChartMouseEvent(event);
    return true;
  }, [onCursorDateChange, panel.height, renderer, scene]);
  const clearCursor = useCallback(() => {
    setCursorYRatio(null);
    onCursorDateChange(null);
  }, [onCursorDateChange]);
  const startDrag = useCallback((event: ChartMouseEvent) => {
    onActivate?.();
    onPointerPress();
    // The plot consumes the press, so the browser never moves focus off a text
    // field for us. Hand it back, but only for a press that truly landed here:
    // a dialog over the plot must keep the focus it just took.
    if (isDesktopWeb) releaseEditableFocus(event);
    consumeChartMouseEvent(event);
    // A keyboard-armed tool covers terminals that never forward modifier drags.
    const tool = resolveChartToolKind(event.modifiers) ?? armedTool;
    if (tool) {
      const ratios = pointerRatios(event);
      if (!ratios) return;
      // With a drawing tool in hand, grabbing an existing shape edits it
      // instead of starting a new one on top of it.
      const hit = isDrawingTool(tool)
        ? hitTestDrawings(drawings, scene, panel, ratios, plotAspect)
        : null;
      if (hit) {
        onSelectDrawing(hit.drawing.id);
        dragRef.current = {
          kind: "edit",
          drawingId: hit.drawing.id,
          pointIndex: hit.pointIndex,
          lastXRatio: ratios.xRatio,
          lastYRatio: ratios.yRatio,
        };
        updateCursor(event);
        return;
      }
      const started: ChartToolDrag = {
        kind: tool,
        startXRatio: ratios.xRatio,
        startYRatio: ratios.yRatio,
        endXRatio: ratios.xRatio,
        endYRatio: ratios.yRatio,
        path: [{ xRatio: ratios.xRatio, yRatio: ratios.yRatio }],
      };
      if (isDrawingTool(tool)) onSelectDrawing(null);
      dragRef.current = { ...started, path: [...started.path] };
      setToolDrag(started);
      updateCursor(event);
      return;
    }
    if (!updateCursor(event)) return;
    dragRef.current = startPanGesture(
      frame,
      viewport,
      plotWidth,
      getGlobalMouseX(event, renderer),
      plotSpanFactor,
    );
  }, [
    armedTool,
    drawings,
    frame,
    onActivate,
    onPointerPress,
    onSelectDrawing,
    panel,
    plotAspect,
    plotSpanFactor,
    plotWidth,
    pointerRatios,
    renderer,
    scene,
    updateCursor,
    viewport,
  ]);
  const pressCursor = useCallback((event: ChartMouseEvent) => {
    onActivate?.();
    updateCursor(event);
  }, [onActivate, updateCursor]);
  const dragViewport = useCallback((event: ChartMouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    consumeChartMouseEvent(event);
    updateCursor(event);
    if (drag.kind === "edit") {
      const ratios = pointerRatios(event);
      if (!ratios) return;
      // Read the deltas before advancing the ref: the state updater runs later,
      // and a mutable capture would hand it a zero move every time.
      const deltaXRatio = ratios.xRatio - drag.lastXRatio;
      const deltaYRatio = ratios.yRatio - drag.lastYRatio;
      const { drawingId, pointIndex } = drag;
      drag.lastXRatio = ratios.xRatio;
      drag.lastYRatio = ratios.yRatio;
      onEditDrawing(
        drawingId,
        (drawing) => shiftDrawing(drawing, scene, panel, deltaXRatio, deltaYRatio, pointIndex),
      );
      return;
    }
    if (drag.kind !== "pan") {
      const ratios = pointerRatios(event);
      if (!ratios) return;
      drag.endXRatio = ratios.xRatio;
      drag.endYRatio = ratios.yRatio;
      if (drag.kind === "pencil") drag.path.push({ xRatio: ratios.xRatio, yRatio: ratios.yRatio });
      setToolDrag({ ...drag, path: [...drag.path] });
      return;
    }
    const globalX = getGlobalMouseX(event, renderer);
    if (drag.frame !== frame) {
      // Data refreshed mid-drag. The new frame maps positions differently, so
      // continue from where the plot is now instead of replaying the drag.
      Object.assign(drag, startPanGesture(frame, viewport, plotWidth, globalX, plotSpanFactor));
    }
    onPanViewport(
      (globalX - drag.startGlobalX) * drag.positionsPerCell,
      { frame: drag.frame, from: drag.startViewport },
    );
  }, [
    frame,
    onEditDrawing,
    onPanViewport,
    panel,
    plotSpanFactor,
    plotWidth,
    pointerRatios,
    renderer,
    scene,
    updateCursor,
    viewport,
  ]);
  const finishToolDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag || drag.kind === "pan") return;
    dragRef.current = null;
    if (drag.kind === "edit") return;
    setToolDrag(null);
    if (isDrawingTool(drag.kind)) {
      const drawing = resolveDrawingFromDrag(scene, panel, drag, drawColor, nextDrawingId());
      if (drawing) onDraw(drawing);
      return;
    }
    if (drag.kind !== "zoom") return;
    const range = resolveZoomBoxRange(scene, drag, frame.minimumSpanMs);
    if (range) onSetViewport(range);
  }, [drawColor, frame.minimumSpanMs, onDraw, onSetViewport, panel, scene]);
  const resetDrag = useCallback(() => {
    if (dragRef.current?.kind === "pan") {
      dragRef.current = null;
      return;
    }
    finishToolDrag();
  }, [finishToolDrag]);
  const handleMouseMove = useCallback((event: ChartMouseEvent) => {
    // A release over a neighbouring pane never reaches this surface, so treat a
    // plain move, which only fires with no button held, as the missing release.
    finishToolDrag();
    updateCursor(event);
  }, [finishToolDrag, updateCursor]);
  // Trackpads fire wheel events faster than the plot can paint, so one frame
  // absorbs every event that arrived since the last one.
  const pendingWheelRef = useRef<PendingWheel | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const latestWheelStateRef = useRef({ frame, viewport, onPanViewport, onZoomViewport, plotSpanFactor });
  latestWheelStateRef.current = { frame, viewport, onPanViewport, onZoomViewport, plotSpanFactor };
  const flushWheel = useCallback(() => {
    wheelFrameRef.current = null;
    const pending = pendingWheelRef.current;
    pendingWheelRef.current = null;
    if (!pending) return;
    const latest = latestWheelStateRef.current;
    if (pending.panRatio !== 0) {
      const positions = compositeViewportPositions(latest.frame, latest.viewport);
      const span = positions ? Math.max(positions.end - positions.start, Number.EPSILON) : 0;
      latest.onPanViewport(pending.panRatio * span * latest.plotSpanFactor);
    }
    if (pending.zoomLog !== 0) {
      latest.onZoomViewport(Math.exp(pending.zoomLog), pending.anchorRatio);
    }
  }, []);
  useEffect(() => () => {
    pendingWheelRef.current = null;
    if (wheelFrameRef.current !== null) {
      webFrame.cancelAnimationFrame?.(wheelFrameRef.current);
      wheelFrameRef.current = null;
    }
  }, []);
  const panFromWheel = useCallback((event: ChartMouseEvent) => {
    const scroll = event.scroll;
    if (!scroll) return;
    onActivate?.();
    consumeChartMouseEvent(event);
    const pointerTarget = plotRef.current as unknown as Parameters<typeof getLocalPlotPointer>[1];
    const pointer = getLocalPlotPointer(event, pointerTarget, renderer);
    updateCursor(event);
    const pending = pendingWheelRef.current ?? { panRatio: 0, zoomLog: 0, anchorRatio: 0.5 };
    if (event.modifiers.ctrl && pointer && isVerticalWheelDirection(scroll.direction)) {
      pending.zoomLog += Math.log(resolveCompositeWheelZoom(scroll));
      // The anchor is a fraction of the viewport, so a pointer over the empty
      // right offset anchors on the newest observation instead of past it.
      pending.anchorRatio = Math.min(
        1,
        pointer.cellX / Math.max(plotWidth - 1, 1) * plotSpanFactor,
      );
    } else {
      pending.panRatio += resolveCompositeWheelPan(scroll, plotWidth * cellWidthPx);
    }
    pendingWheelRef.current = pending;
    if (!isDesktopWeb || typeof webFrame.requestAnimationFrame !== "function") {
      flushWheel();
      return;
    }
    if (wheelFrameRef.current === null) {
      wheelFrameRef.current = webFrame.requestAnimationFrame(flushWheel);
    }
  }, [
    cellWidthPx,
    flushWheel,
    isDesktopWeb,
    onActivate,
    plotSpanFactor,
    plotWidth,
    renderer,
    updateCursor,
  ]);

  return (
    <Box
      flexDirection="row"
      height={panel.height}
      width={plotWidth + leftAxisWidth + rightAxisWidth + axisGap * ((leftAxisWidth ? 1 : 0) + (rightAxisWidth ? 1 : 0))}
      position="relative"
    >
      {measureReadout ? (
        <Box
          position="absolute"
          left={measureReadout.left}
          top={measureReadout.top}
          width={measureReadout.width}
          height={1}
          zIndex={25}
          backgroundColor={colors.background}
          style={isDesktopWeb
            ? {
              width: "auto",
              paddingInline: 4,
              borderRadius: 4,
              backgroundColor: `color-mix(in srgb, ${colors.background} 82%, transparent)`,
            }
            : undefined}
          data-gloom-role="composite-chart-measure"
        >
          <Text fg={measureReadout.color}>{measureReadout.text}</Text>
        </Box>
      ) : null}
      {leftAxisWidth > 0 ? (
        <>
          <PriceAxisLabels
            axisLabels={leftAxisLabels}
            axisTicks={leftAxisTicks}
            axisWidth={leftAxisWidth}
            axisSectionWidth={leftAxisWidth}
            side="left"
            height={panel.height}
            cursorRow={cursorRow}
            cursorPixelY={cursorPixelY}
            cursorLabel={leftCursorLabel}
            cursorColor={colors.crosshair}
            cursorBackgroundColor={colors.background}
            axisColor={colors.textDim}
            extraMarkers={leftAxisMarkers}
          />
          <Box width={axisGap} />
        </>
      ) : null}
      <ChartSurface
        ref={plotRef}
        width={plotWidth}
        height={panel.height}
        flexDirection="column"
        bitmaps={bitmapLayers}
        crosshair={crosshair}
        vectors={vectors}
        onMouseMove={interactive ? handleMouseMove : undefined}
        onMouseDown={interactive ? navigable ? startDrag : pressCursor : undefined}
        onMouseDrag={interactive && navigable ? dragViewport : undefined}
        onMouseUp={interactive && navigable ? resetDrag : undefined}
        onMouseDragEnd={interactive && navigable ? resetDrag : undefined}
        onMouseScroll={interactive && navigable ? panFromWheel : undefined}
        onMouseOut={interactive ? clearCursor : undefined}
        cursor={interactive ? toolDrag || !navigable ? "crosshair" : "grab" : undefined}
        data-gloom-interactive={interactive ? "true" : undefined}
        data-gloom-role={COMPOSITE_PANEL_ROLE}
        data-gloom-remote-kind={remoteKind}
        data-gloom-label={panel.label ?? panel.id}
      >
        {textLines.map((line, index) => <Text key={index} fg={colors.text}>{line}</Text>)}
      </ChartSurface>
      {rightAxisWidth > 0 ? (
        <>
          <Box width={axisGap} />
          <PriceAxisLabels
            axisLabels={rightAxisLabels}
            axisTicks={rightAxisTicks}
            axisWidth={rightAxisWidth}
            axisSectionWidth={rightAxisWidth}
            side="right"
            height={panel.height}
            cursorRow={cursorRow}
            cursorPixelY={cursorPixelY}
            cursorLabel={rightCursorLabel}
            cursorColor={colors.crosshair}
            cursorBackgroundColor={colors.background}
            axisColor={colors.textDim}
            extraMarkers={rightAxisMarkers}
          />
        </>
      ) : null}
    </Box>
  );
}

function legendValue(
  series: ResolvedSeries,
  value: number | null,
  formatValue: CompositeChartProps["formatValue"],
  scene: CompositeChartScene | null,
): string {
  if (value === null) return "—";
  return formatValue ? formatValue(value, series) : formatCompositeSeriesValue(value, series, axisPriceReference(scene, series));
}

/** The reference the axis holding a series keeps for its asset, so an average
 * of the price shows the price's decimals rather than its own float tail. A
 * series far from that price (another coin on a shared axis) keeps its own. */
function axisPriceReference(scene: CompositeChartScene | null, series: ResolvedSeries): number | undefined {
  const own = seriesPriceReference(series);
  for (const panel of scene?.panels ?? []) {
    for (const domain of [panel.axes.left, panel.axes.right]) {
      if (!domain?.seriesIds.includes(series.id)) continue;
      const shared = domain.priceReferences?.[series.priceAssetCategory ?? ""];
      if (shared === undefined || own === undefined) return own ?? shared;
      const ratio = Math.abs(own / shared);
      return ratio > 0.1 && ratio < 10 ? shared : own;
    }
  }
  return own;
}

const LISTED_TICKER_PATTERN = /(^|[\s(])([A-Z0-9^][A-Z0-9.^=/-]*):([A-Z0-9]{2,})(?=$|[\s),])/g;

/** `Volume AAPL:XNAS Price` → `Volume AAPL Price`, for a legend name that must shorten. */
function withoutListingExchange(label: string): string {
  return label.replace(LISTED_TICKER_PATTERN, (match, lead: string, symbol: string, exchange: string) => (
    CANONICAL_EXCHANGE_ALIASES[exchange] ? `${lead}${symbol}` : match
  ));
}

function CompositeLegend({
  scene,
  series,
  visibleSeriesIds,
  width,
  accessory,
  accessoryWidth,
  formatValue,
  showLatestChangePercent,
  onActivate,
  onToggleSeries,
  isSeriesToggleable,
  keyboardIndex,
}: {
  scene: CompositeChartScene | null;
  series: ResolvedSeries[];
  visibleSeriesIds: ReadonlySet<string>;
  width: number;
  accessory: CompositeChartProps["legendAccessory"];
  accessoryWidth: CompositeChartProps["legendAccessoryWidth"];
  formatValue: CompositeChartProps["formatValue"];
  showLatestChangePercent: CompositeChartProps["showLatestChangePercent"];
  onActivate: CompositeChartProps["onActivate"];
  onToggleSeries: CompositeChartProps["onToggleSeries"];
  isSeriesToggleable: CompositeChartProps["isSeriesToggleable"];
  keyboardIndex?: number | null;
}) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const cursorValueById = new Map(
    scene?.cursorValues.map((entry) => [entry.seriesId, entry] as const) ?? [],
  );
  const entries = series.map((entry) => {
    const toggleable = !!onToggleSeries && (isSeriesToggleable?.(entry) ?? true);
    const cursorValue = cursorValueById.get(entry.id);
    const changeText = showLatestChangePercent
        && !scene?.cursorDate
        && typeof entry.latestChangePercent === "number"
        && Number.isFinite(entry.latestChangePercent)
      ? ` ${formatPercentRaw(entry.latestChangePercent)}`
      : "";
    const valueText = entry.points.length === 0
      ? entry.hidden ? "" : "no data"
      : `${legendValue(
        entry,
        cursorValue?.value ?? null,
        formatValue,
        scene,
      )}${changeText}`;
    const fullText = [entry.label, valueText].filter(Boolean).join(" ");
    const details = formatCompositePointDetails(cursorValue?.point);
    const exactTotal = entry.unitGroup.split(":")[0] === "currency-total"
      && cursorValue?.value != null && Number.isFinite(cursorValue.value)
      ? `Value ${cursorValue.value} ${entry.unit}` : "";
    const tooltip = [fullText, exactTotal, details].filter(Boolean).join(" · ");
    const label = entry.label;
    const compactLabel = withoutListingExchange(label);
    const labelWidth = displayWidth(label);
    const text = [label, valueText].filter(Boolean).join(" ");
    return {
      entry,
      label,
      compactLabel,
      text,
      width: Math.max(1, displayWidth(text)) + 2,
      labelWidth,
      valueText,
      toggleable,
      tooltip,
    };
  });
  type LegendEntry = (typeof entries)[number];
  const setEntryLabel = (target: LegendEntry, label: string, labelWidth: number) => {
    target.label = label;
    target.labelWidth = labelWidth;
    target.text = [truncateToDisplayWidth(label, labelWidth), target.valueText].filter(Boolean).join(" ");
    target.width = Math.max(1, displayWidth(target.text)) + 2;
  };
  const measureSeriesWidth = () => entries.reduce(
    (total, entry, index) => total + entry.width + (index > 0 ? 1 : 0),
    0,
  );
  // One cell in from the pane border, so the first marker and the legend text
  // line up with the query bar and tables above and below the chart.
  const inset = width > 1 ? 1 : 0;
  const innerWidth = Math.max(0, width - inset);
  const resolvedAccessoryWidth = accessory
    ? Math.max(1, Math.min(innerWidth, Math.floor(accessoryWidth ?? 14)))
    : 0;
  const reservedAccessoryGap = accessory && innerWidth > resolvedAccessoryWidth ? 1 : 0;
  // The cursor date lives on the time axis, where the crosshair points at it.
  const widthBeforeAccessory = Math.max(0, innerWidth - resolvedAccessoryWidth - reservedAccessoryGap);
  // Names get the room the row has. When it overflows, the widest name
  // shortens first: its listing exchange goes before any of the name is cut.
  // The value (including its sign/unit) always stays intact. If the row cannot
  // fit even with every name at a readable fragment, it keeps the old 30-cell
  // entries and scrolls.
  const minimumSeriesWidth = entries.reduce((total, entry, index) => {
    const text = [truncateToDisplayWidth(entry.compactLabel, Math.min(8, displayWidth(entry.compactLabel))), entry.valueText]
      .filter(Boolean).join(" ");
    return total + Math.max(1, displayWidth(text)) + 2 + (index > 0 ? 1 : 0);
  }, 0);
  if (minimumSeriesWidth <= widthBeforeAccessory) {
    while (measureSeriesWidth() > widthBeforeAccessory) {
      const shrinkable = entries
        .filter((entry) => entry.label !== entry.compactLabel || entry.labelWidth > 8)
        .sort((left, right) => right.labelWidth - left.labelWidth)[0];
      if (!shrinkable) break;
      if (shrinkable.label !== shrinkable.compactLabel) {
        setEntryLabel(shrinkable, shrinkable.compactLabel, Math.min(shrinkable.labelWidth, displayWidth(shrinkable.compactLabel)));
      } else {
        setEntryLabel(shrinkable, shrinkable.label, shrinkable.labelWidth - 1);
      }
    }
  } else {
    for (const entry of entries) {
      const budget = Math.max(0, 30 - (entry.valueText ? displayWidth(entry.valueText) + 1 : 0));
      if (entry.labelWidth > budget) setEntryLabel(entry, entry.compactLabel, budget);
    }
  }
  const desiredSeriesWidth = measureSeriesWidth();
  const seriesWidth = Math.min(desiredSeriesWidth, widthBeforeAccessory);
  const accessorySpacerWidth = accessory
    ? Math.max(reservedAccessoryGap, innerWidth - seriesWidth - resolvedAccessoryWidth)
    : 0;
  const keyboardEntryStart = keyboardIndex === null || keyboardIndex === undefined
    ? null
    : entries.slice(0, keyboardIndex).reduce(
      (total, entry, index) => total + entry.width + (index > 0 ? 1 : 0),
      0,
    ) + (keyboardIndex > 0 ? 1 : 0);
  const keyboardEntryEnd = keyboardEntryStart === null
    ? null
    : keyboardEntryStart + (entries[keyboardIndex!]?.width ?? 0);

  useEffect(() => {
    if (keyboardEntryStart === null || keyboardEntryEnd === null) return;
    const scrollBox = scrollRef.current;
    const viewportWidth = scrollBox?.viewport?.width || scrollBox?.width || seriesWidth;
    if (!scrollBox || viewportWidth <= 0) return;
    const currentLeft = scrollBox.scrollLeft ?? 0;
    const nextLeft = keyboardEntryStart < currentLeft
      ? keyboardEntryStart
      : keyboardEntryEnd > currentLeft + viewportWidth
        ? keyboardEntryEnd - viewportWidth
        : currentLeft;
    if (nextLeft === currentLeft) return;
    scrollBox.scrollLeft = nextLeft;
    scrollBox.scrollTo({ x: nextLeft, y: scrollBox.scrollTop });
  }, [keyboardEntryEnd, keyboardEntryStart, seriesWidth]);
  const handleMouseScroll = (event?: {
    preventDefault?: () => void;
    stopPropagation?: () => void;
    scroll?: { direction?: string; delta?: number };
  }) => {
    const direction = event?.scroll?.direction;
    const scrollBox = scrollRef.current;
    const viewportWidth = scrollBox?.viewport?.width || scrollBox?.width || 0;
    const contentWidth = Math.max(desiredSeriesWidth, scrollBox?.scrollWidth ?? 0);
    if (!direction || !scrollBox || viewportWidth <= 0 || contentWidth <= viewportWidth) return;

    event.preventDefault?.();
    event.stopPropagation?.();
    const rawDelta = Math.abs(event.scroll?.delta ?? 1);
    const deltaCells = Math.max(1, Math.round(rawDelta / LEGEND_WHEEL_DELTA_PER_CELL));
    const directionSign = direction === "right" || direction === "down" ? 1 : -1;
    const nextLeft = Math.max(
      0,
      Math.min(
        contentWidth - viewportWidth,
        (scrollBox.scrollLeft ?? 0) + directionSign * deltaCells,
      ),
    );
    scrollBox.scrollLeft = nextLeft;
    scrollBox.scrollTo({ x: nextLeft, y: scrollBox.scrollTop });
  };
  return (
    <Box
      flexDirection="row"
      alignItems="flex-end"
      width={width}
      height={1}
      paddingLeft={inset}
      overflow="visible"
      // Accessory dropdowns must escape above the sibling drawing toolbar.
      zIndex={accessory ? 40 : 20}
      data-gloom-role="composite-chart-legend"
    >
      {seriesWidth > 0 ? (
        <ScrollBox
          ref={scrollRef}
          width={seriesWidth}
          height={1}
          flexShrink={0}
          scrollX
          focusable={false}
          horizontalScrollbarOptions={{ visible: false }}
          onMouseScroll={handleMouseScroll}
          data-gloom-role="composite-chart-legend-scroll"
        >
          <Box flexDirection="row" width={desiredSeriesWidth} height={1} gap={1}>
            {entries.map(({ entry, text, toggleable, tooltip, width: entryWidth }, index) => {
              const entryVisible = visibleSeriesIds.has(entry.id);
              return (
              <Box
                key={entry.id}
                flexDirection="row"
                alignItems="center"
                width={entryWidth}
                height={1}
                flexShrink={0}
                overflow="hidden"
                backgroundColor={keyboardIndex === index ? themeColors.selected : undefined}
                hoverBackgroundColor={toggleable ? hoverBg() : undefined}
                onMouseDown={toggleable ? (event: ChartMouseEvent) => {
                  onActivate?.();
                  consumeChartMouseEvent(event);
                  onToggleSeries?.(entry.id);
                } : undefined}
                cursor={toggleable ? "pointer" : undefined}
                data-gloom-interactive={toggleable ? "true" : undefined}
                data-gloom-role="composite-chart-legend-series"
                data-gloom-label={`${toggleable
                  ? `${entryVisible ? "Hide" : "Show"} `
                  : ""}${tooltip}`}
                data-visible={entryVisible ? "true" : "false"}
                title={isDesktopWeb ? tooltip : undefined}
              >
                {isDesktopWeb ? (
                  <Box
                    flexShrink={0}
                    style={{
                      width: 8,
                      height: 8,
                      marginInlineEnd: 6,
                      borderRadius: 999,
                      border: `1px solid ${entry.color}`,
                      backgroundColor: entryVisible ? entry.color : "transparent",
                    }}
                    data-gloom-role="composite-chart-legend-marker"
                  />
                ) : (
                  <Text fg={entryVisible ? entry.color : themeColors.textMuted}>● </Text>
                )}
                {/* The filled/hollow marker already says whether a series is
                    shown; the word only repeated it in every legend slot. */}
                <Text fg={entryVisible ? themeColors.text : themeColors.textDim}>{text}</Text>
              </Box>
              );
            })}
          </Box>
        </ScrollBox>
      ) : null}
      {accessorySpacerWidth > 0 ? (
        <Box width={accessorySpacerWidth} flexShrink={0} />
      ) : null}
      {accessory ? (
        <Box
          position="relative"
          width={resolvedAccessoryWidth}
          flexShrink={0}
          height={1}
          overflow="visible"
          zIndex={21}
        >
          {accessory}
        </Box>
      ) : null}
    </Box>
  );
}

const NO_DRAWINGS: readonly ChartDrawing[] = [];
const NO_X_MARKERS: readonly CompositeChartXMarker[] = [];
/** Coalesces a drag into one write instead of one per pointer move. */
const DRAWING_PERSIST_DELAY_MS = 400;

/**
 * Drawings are anchored to data, so they outlive the mounted chart: they ride
 * along with the pane settings that already carry the chart spec. Only mounted
 * inside a pane, so a standalone chart still renders without app state.
 */
function ChartDrawingStore({
  paneInstanceId,
  drawings,
  onRestore,
}: {
  paneInstanceId: string;
  drawings: readonly ChartDrawing[];
  onRestore: (drawings: readonly ChartDrawing[]) => void;
}) {
  const [stored, setStored] = usePaneSettingValue<readonly ChartDrawing[]>(
    CHART_DRAWINGS_SETTING_KEY,
    NO_DRAWINGS,
    paneInstanceId,
  );
  const restoredRef = useRef<readonly ChartDrawing[] | null>(null);
  if (restoredRef.current === null) {
    restoredRef.current = parseChartDrawings(stored);
  }

  useEffect(() => {
    const restored = restoredRef.current;
    if (restored && restored.length > 0) onRestore(restored);
    // Restoring once on mount: later writes must not scroll back in time.
  }, []);

  useEffect(() => {
    const restored = restoredRef.current ?? NO_DRAWINGS;
    if (drawings === restored) return;
    if (drawings.length === 0 && restored.length === 0) return;
    const timer = setTimeout(() => setStored(drawings), DRAWING_PERSIST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [drawings, setStored]);

  return null;
}

export function CompositeChart({
  series,
  legendSeries,
  timelineSeries,
  panels,
  width,
  height,
  focused = false,
  cursorDate,
  viewport,
  clipToViewport = false,
  viewportResetKey,
  colors,
  interactive = true,
  navigable = true,
  formatAxisValue,
  xAxis,
  remoteKind,
  allowHistoricalBackfill = false,
  axisWidth = 9,
  showLegend = true,
  showLatestChangePercent = false,
  legendAccessory,
  legendAccessoryWidth,
  showTimeAxis = true,
  emptyMessage = "No chart data",
  formatValue,
  onCursorDateChange,
  onViewportChange,
  onActivate,
  onToggleSeries,
  isSeriesToggleable,
}: CompositeChartProps) {
  const activeThemeColors = useThemeColors();
  const { cellWidthPx = 8, cellHeightPx = 18, pixelRatio = 1, fractionalViewport = false } = useUiCapabilities();
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const showTextFallback = useShowChartTextFallback();
  const [internalCursorDate, setInternalCursorDate] = useState<Date | null>(null);
  const [legendKeyboardIndex, setLegendKeyboardIndex] = useState<number | null>(null);
  const [toolSpan, setToolSpan] = useState<ChartToolSpan | null>(null);
  const [armedTool, setArmedTool] = useState<ChartToolKind | null>(null);
  const [keyboardPlacement, setKeyboardPlacement] = useState<KeyboardToolPlacement | null>(null);
  const keyboardId = `composite-chart:${useId()}`;
  const paneInstanceId = useOptionalPaneInstanceId();
  const [drawings, setDrawings] = useState<readonly ChartDrawing[]>(NO_DRAWINGS);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [drawColor, setDrawColor] = useState<string>(CHART_DRAWING_COLORS[0]);
  const addDrawing = useCallback((drawing: ChartDrawing) => {
    setDrawings((current) => [...current, drawing]);
    setSelectedDrawingId(drawing.id);
  }, []);
  const editDrawing = useCallback((
    id: string,
    update: (drawing: ChartDrawing) => ChartDrawing,
  ) => {
    setDrawings((current) => current.map((drawing) => drawing.id === id ? update(drawing) : drawing));
  }, []);
  const removeDrawing = useCallback(() => {
    setDrawings((current) => {
      if (current.length === 0) return current;
      const target = selectedDrawingId
        ? current.filter((drawing) => drawing.id !== selectedDrawingId)
        : current.slice(0, -1);
      return target.length === current.length ? current.slice(0, -1) : target;
    });
    setSelectedDrawingId(null);
  }, [selectedDrawingId]);
  const pickDrawColor = useCallback((color: string) => {
    setDrawColor(color);
    if (!selectedDrawingId) return;
    setDrawings((current) => current.map(
      (drawing) => drawing.id === selectedDrawingId ? { ...drawing, color } : drawing,
    ));
  }, [selectedDrawingId]);
  const resolvedCursorDate = cursorDate === undefined ? internalCursorDate : cursorDate;
  const totalWidth = Math.max(1, Math.floor(width));
  const totalHeight = Math.max(1, Math.floor(height));
  const seriesIdentityRef = useRef<ResolvedSeries[]>([]);
  const stableSeries = reuseResolvedSeriesList(seriesIdentityRef.current, series);
  seriesIdentityRef.current = stableSeries;
  const visibleSeries = useMemo(() => stableSeries.filter((entry) => entry.points.length > 0), [stableSeries]);
  // Panel layout follows the authored series so a panel keeps its height while
  // its data loads; only the marks inside it wait for observations.
  const panelSeries = useMemo(() => stableSeries.filter((entry) => !entry.hidden), [stableSeries]);
  const marketTimelineSeries = useMemo(() => {
    const supplied = timelineSeries?.filter((entry) => entry.points.length > 0) ?? [];
    return supplied.some((entry) => entry.timeBasis?.kind === "market")
      ? supplied
      : visibleSeries;
  }, [timelineSeries, visibleSeries]);
  // A series with no observation in this window stays listed. Dropping it made
  // the legend disagree with the series editor and looked like the chart had
  // silently thrown the series away.
  const visibleLegendSeries = useMemo(
    () => legendSeries ?? visibleSeries,
    [legendSeries, visibleSeries],
  );
  const visibleSeriesIds = useMemo(
    () => new Set(visibleSeries.map((entry) => entry.id)),
    [visibleSeries],
  );
  useEffect(() => {
    setLegendKeyboardIndex((current) => (
      current === null || visibleLegendSeries.length === 0
        ? null
        : Math.min(current, visibleLegendSeries.length - 1)
    ));
  }, [visibleLegendSeries.length]);
  const previousAuthoredViewportRef = useRef<CompositeViewportRange | null>(viewport ?? null);
  const previousViewportResetKeyRef = useRef(viewportResetKey);
  // The user owns this once they navigate. Data refreshes never rewrite it;
  // only the authored viewport changing or an explicit reset clears it.
  const [userViewport, setUserViewport] = useState<CompositeViewportRange | null>(null);
  const hasViewportResetKey = viewportResetKey !== undefined
    || previousViewportResetKeyRef.current !== undefined;
  const authoredViewportChanged = hasViewportResetKey
    ? previousViewportResetKeyRef.current !== viewportResetKey
    : shouldResetCompositeViewport(
        previousAuthoredViewportRef.current,
        viewport ?? null,
      );
  const navigationFrame = useMemo(
    () => buildCompositeNavigationFrame(visibleSeries, marketTimelineSeries, {
      historicalPaddingRatio: allowHistoricalBackfill ? HISTORICAL_PADDING_RATIO : 0,
    }),
    [allowHistoricalBackfill, marketTimelineSeries, visibleSeries],
  );
  const authoredViewport = useMemo(() => {
    // The requested dates own the axis, including gaps in a cached or partial
    // response. Fitting them to available observations silently changes the
    // research period. User pan/zoom gestures retain their navigation limits.
    if (viewport && Number.isFinite(viewport.start.getTime())
      && Number.isFinite(viewport.end.getTime()) && viewport.start <= viewport.end) return viewport;
    return navigationFrame ? compositeNavigationDataViewport(navigationFrame) : null;
  }, [navigationFrame, viewport]);
  const activeUserViewport = authoredViewportChanged ? null : userViewport;
  const effectiveViewport = activeUserViewport ?? authoredViewport;
  const userViewportStart = activeUserViewport?.start.getTime() ?? null;
  const userViewportEnd = activeUserViewport?.end.getTime() ?? null;
  const lastReportedViewportRef = useRef<string | null>(null);
  const viewportInteractionRef = useRef<"pan" | "reset" | "zoom">("reset");
  useEffect(() => {
    if (!onViewportChange) return;
    const key = userViewportStart === null || userViewportEnd === null
      ? "none"
      : `${userViewportStart}:${userViewportEnd}`;
    // The callback drives adaptive data loading. Seed it from the authored
    // viewport without echoing that controlled value back into the loader.
    if (lastReportedViewportRef.current === null) {
      lastReportedViewportRef.current = key;
      return;
    }
    if (lastReportedViewportRef.current === key) return;
    lastReportedViewportRef.current = key;
    onViewportChange(
      userViewportStart === null || userViewportEnd === null
        ? null
        : { start: new Date(userViewportStart), end: new Date(userViewportEnd) },
      viewportInteractionRef.current,
    );
  }, [onViewportChange, userViewportEnd, userViewportStart]);

  useEffect(() => {
    previousAuthoredViewportRef.current = viewport ?? null;
    previousViewportResetKeyRef.current = viewportResetKey;
    if (authoredViewportChanged && userViewport) {
      viewportInteractionRef.current = "reset";
      setUserViewport(null);
    }
  }, [authoredViewportChanged, userViewport, viewport, viewportResetKey]);

  const navigate = useCallback((
    kind: "pan" | "zoom",
    compute: (base: CompositeViewportRange, frame: CompositeNavigationFrame) => CompositeViewportRange,
    gesture?: { frame: CompositeNavigationFrame; from: CompositeViewportRange },
  ) => {
    const frame = gesture?.frame ?? navigationFrame;
    if (!frame) return;
    viewportInteractionRef.current = kind;
    setUserViewport((current) => {
      const base = gesture?.from ?? current ?? authoredViewport;
      if (!base) return current;
      const next = compute(base, frame);
      // Once navigated, the window is the user's until they reset it, even if
      // a gesture happens to land back on the authored range: the owner may
      // echo a navigated range back as the authored one, and dropping to null
      // there would reload the original range under the pointer.
      return sameCompositeViewport(next, current ?? base) ? current : next;
    });
  }, [authoredViewport, navigationFrame]);
  const panViewport = useCallback((
    deltaPositions: number,
    gesture?: { frame: CompositeNavigationFrame; from: CompositeViewportRange },
  ) => {
    navigate("pan", (base, frame) => panCompositeViewport(frame, base, deltaPositions), gesture);
  }, [navigate]);
  const panViewportByRatio = useCallback((shiftRatio: number) => {
    if (!navigationFrame || !effectiveViewport) return;
    const positions = compositeViewportPositions(navigationFrame, effectiveViewport);
    if (!positions) return;
    panViewport(shiftRatio * Math.max(positions.end - positions.start, Number.EPSILON));
  }, [effectiveViewport, navigationFrame, panViewport]);
  const zoomViewport = useCallback((zoomFactor: number, anchorRatio = 1) => {
    navigate("zoom", (base, frame) => zoomCompositeViewport(frame, base, zoomFactor, anchorRatio));
  }, [navigate]);
  const setViewportRange = useCallback((range: CompositeViewportRange) => {
    navigate("zoom", (_base, frame) => fitCompositeViewport(frame, range));
  }, [navigate]);
  const resetViewport = useCallback(() => {
    viewportInteractionRef.current = "reset";
    setUserViewport(null);
  }, []);
  // Sticky while armed: the toolbar chip shows which tool owns the drag, and a
  // one-shot tool would blink off before the user could see it.
  const armTool = useCallback((tool: ChartToolKind | null) => {
    setArmedTool((current) => current === tool ? null : tool);
    setKeyboardPlacement(null);
    if (tool === null) setSelectedDrawingId(null);
  }, []);
  const cancelKeyboardPlacement = useCallback(() => setKeyboardPlacement(null), []);
  const legendRows = showLegend && (visibleSeries.length > 0 || legendAccessory)
    ? 1
    : 0;
  const timeAxisRows = showTimeAxis ? 1 : 0;
  const xMarkers = xAxis?.markers ?? NO_X_MARKERS;
  const xMarkerRows = xMarkers.some((marker) => marker.label) ? 1 : 0;
  const panelCount = new Set(panelSeries.map((entry) => entry.panelId)).size;
  // A forming bar can change its extremes or volume without moving its close.
  const lastTickKey = visibleSeries.map((entry) => {
    const last = entry.points.at(-1);
    if (!last) return entry.id;
    return `${entry.id}:${last.date.getTime()}:${last.close ?? ""}:${last.value ?? ""}:${last.high ?? ""}:${last.low ?? ""}:${last.volume ?? ""}:${entry.latestChangePercent ?? ""}`;
  }).join("|");
  const plotHeight = Math.max(panelCount, totalHeight - legendRows - timeAxisRows - xMarkerRows);
  const resolvedColors = useMemo<CompositeChartColors>(() => ({
    background: colors?.background ?? activeThemeColors.bg,
    grid: colors?.grid ?? activeThemeColors.border,
    crosshair: colors?.crosshair ?? activeThemeColors.borderFocused,
    text: colors?.text ?? activeThemeColors.text,
    textDim: colors?.textDim ?? activeThemeColors.textDim,
    negative: colors?.negative ?? activeThemeColors.negative,
  }), [activeThemeColors, colors]);
  // A custom x axis means x is not time: a tenor, a fraction, a return. Its
  // last observation belongs at the right edge, under its own label.
  const rightOffsetRatio = xAxis ? 0 : COMPOSITE_RIGHT_OFFSET_RATIO;
  const projectedScene = useMemo(() => {
    // lastTickKey busts this memo when a live tick mutates series identity in place.
    void lastTickKey;
    return buildCompositeChartScene(panelSeries, panels, {
      width: 1,
      height: Math.max(panelCount, 1),
      viewport: effectiveViewport ?? undefined,
      clipToViewport,
      timelineSeries: marketTimelineSeries,
      rightOffsetRatio,
    });
  }, [
    clipToViewport,
    effectiveViewport,
    lastTickKey,
    marketTimelineSeries,
    panelCount,
    panelSeries,
    panels,
    rightOffsetRatio,
  ]);
  // Gutters follow the axes the scene actually built. Reading the series list
  // instead drops a gutter the moment its series has no observation in view,
  // which is exactly what a zoom does, taking the axis labels with it.
  const scenePanels = projectedScene?.panels;
  const hasLeftAxis = scenePanels
    ? scenePanels.some((panel) => !!panel.axes.left)
    : visibleSeries.some((entry) => entry.axis === "left");
  const hasRightAxis = scenePanels
    ? scenePanels.some((panel) => !!panel.axes.right)
    : visibleSeries.some((entry) => entry.axis === "right");
  const maximumAxisWidth = Math.max(0, Math.floor(axisWidth));
  // Gutters follow their labels. A fixed budget left dead space beside short
  // prices, which costs plot width on every chart that does not need it.
  const axisCount = Number(hasLeftAxis) + Number(hasRightAxis);
  // Keep at least half the chart (and 12 cells on small charts) for the plot.
  const minimumPlotWidth = Math.min(totalWidth, Math.max(12, Math.floor(totalWidth / 2)));
  const availableAxisWidth = axisCount > 0
    ? Math.max(0, Math.floor((totalWidth - minimumPlotWidth) / axisCount) - 1)
    : 0;
  const layoutPanels = useMemo<CompositePanelScene[] | null>(() => {
    if (!projectedScene) return null;
    const panelSpecById = new Map(panels.map((panel) => [panel.id, panel] as const));
    const panelHeights = allocateCompositePanelHeights(
      projectedScene.panels.map((panel) => ({
        id: panel.id,
        height: panelSpecById.get(panel.id)?.height,
      })),
      plotHeight,
    );
    // Terminal labels snap to rows; a fractional viewport places them exactly.
    return projectedScene.panels.map((panel) => resizeCompositePanel(panel, panelHeights.get(panel.id) ?? 1, !fractionalViewport));
  }, [fractionalViewport, panels, plotHeight, projectedScene]);
  // Static overview charts also pin the latest price with cursor precision.
  const includeCursorLabels = interactive || cursorDate !== undefined || !!scenePanels?.some((panel) => panel.lastPrice);
  const resolvedAxisWidth = useMemo(() => maximumAxisWidth === 0 ? 0 : Math.min(
    availableAxisWidth,
    Math.max(
      Math.min(MINIMUM_AXIS_LABEL_WIDTH, maximumAxisWidth),
      ...(layoutPanels ?? []).flatMap((panel) => [
        compositeAxisLabelWidth(panel.axes.left, formatAxisValue, includeCursorLabels),
        compositeAxisLabelWidth(panel.axes.right, formatAxisValue, includeCursorLabels),
      ]).map((width) => includeCursorLabels ? width : Math.min(width, maximumAxisWidth)),
    ),
  ), [availableAxisWidth, formatAxisValue, includeCursorLabels, layoutPanels, maximumAxisWidth]);
  const leftAxisWidth = hasLeftAxis ? resolvedAxisWidth : 0;
  const rightAxisWidth = hasRightAxis ? resolvedAxisWidth : 0;
  const axisGap = resolvedAxisWidth > 0 ? 1 : 0;
  const horizontalReserved = leftAxisWidth + rightAxisWidth
    + axisGap * ((leftAxisWidth ? 1 : 0) + (rightAxisWidth ? 1 : 0));
  const plotWidth = Math.max(1, totalWidth - horizontalReserved);
  const watermarkScale = isDesktopWeb
    ? chartWatermarkScale(plotWidth * cellWidthPx, plotHeight * cellHeightPx)
    : null;
  const downsampleWidth = Math.max(
    1,
    Math.round(plotWidth * cellWidthPx * Math.max(1, pixelRatio)),
  );
  const baseScene = useMemo<CompositeChartScene | null>(() => {
    if (!projectedScene || !layoutPanels) return null;
    const laidOut: CompositeChartScene = {
      ...projectedScene,
      width: plotWidth,
      height: layoutPanels.reduce((sum, panel) => sum + panel.height, 0),
      panels: layoutPanels,
    };
    return downsampleCompositeChartScene(laidOut, downsampleWidth);
  }, [downsampleWidth, layoutPanels, plotWidth, projectedScene]);
  const resolvedCursorTimestamp = resolvedCursorDate?.getTime() ?? null;
  const normalizedCursorTimestamp = resolvedCursorTimestamp !== null && Number.isFinite(resolvedCursorTimestamp)
    ? resolvedCursorTimestamp
    : null;
  const scene = useMemo(() => (
    baseScene
      ? applyCompositeChartCursor(
        baseScene,
        normalizedCursorTimestamp === null ? null : new Date(normalizedCursorTimestamp),
      )
      : null
  ), [baseScene, normalizedCursorTimestamp]);
  const handleEmptyMouseScroll = useCallback((event: ChartMouseEvent) => {
    const scroll = event.scroll;
    if (!interactive || !navigationFrame || !scroll) return;
    onActivate?.();
    consumeChartMouseEvent(event);
    if (event.modifiers.ctrl && isVerticalWheelDirection(scroll.direction)) {
      const factor = resolveCompositeWheelZoom(scroll);
      if (factor < 1) {
        resetViewport();
        return;
      }
      zoomViewport(factor, 0.5);
      return;
    }
    panViewportByRatio(resolveCompositeWheelPan(scroll, plotWidth * cellWidthPx));
  }, [
    cellWidthPx,
    interactive,
    navigationFrame,
    onActivate,
    panViewportByRatio,
    plotWidth,
    resetViewport,
    zoomViewport,
  ]);
  const keyboardCursorDateRef = useRef<Date | null>(scene?.cursorDate ?? null);
  keyboardCursorDateRef.current = scene?.cursorDate ?? null;
  const lastCursorTimestampRef = useRef<number | null>(normalizedCursorTimestamp);
  const renderedCursorTimestampRef = useRef<number | null>(normalizedCursorTimestamp);
  if (renderedCursorTimestampRef.current !== normalizedCursorTimestamp) {
    renderedCursorTimestampRef.current = normalizedCursorTimestamp;
    lastCursorTimestampRef.current = normalizedCursorTimestamp;
  }

  const updateCursor = useCallback((date: Date | null) => {
    const timestamp = date?.getTime() ?? null;
    const nextTimestamp = timestamp !== null && Number.isFinite(timestamp) ? timestamp : null;
    if (lastCursorTimestampRef.current === nextTimestamp) return;
    lastCursorTimestampRef.current = nextTimestamp;
    if (cursorDate === undefined) setInternalCursorDate(date);
    onCursorDateChange?.(date);
  }, [cursorDate, onCursorDateChange]);

  // The cursor keys belong to every focused chart; pan, zoom, the tools and
  // their keys only to one that navigates.
  const arrowsClaimed = usePaneArrowsClaimed();
  const keyboardActive = focused && interactive;
  const toolsActive = keyboardActive && navigable;
  useEffect(() => {
    if (!toolsActive) setKeyboardPlacement(null);
  }, [toolsActive]);
  const legendKeysActive = keyboardActive && showLegend && visibleLegendSeries.length > 0;
  const legendEntry = legendKeyboardIndex === null ? undefined : visibleLegendSeries[legendKeyboardIndex];
  const legendEntryToggleable = !!legendEntry && !!onToggleSeries && (isSeriesToggleable?.(legendEntry) ?? true);
  const anyLegendToggleable = legendKeysActive && !!onToggleSeries
    && visibleLegendSeries.some((entry) => isSeriesToggleable?.(entry) ?? true);
  // With a drawing tool in hand, [ and ] step through the drawings instead of
  // the legend, the way a click with that tool picks one.
  const drawingKeysActive = toolsActive && isDrawingTool(armedTool) && drawings.length > 0 && !keyboardPlacement;
  // Backspace only deletes what the user is working on; otherwise it is the
  // pane's back key.
  const canDeleteDrawing = toolsActive && drawings.length > 0 && (!!selectedDrawingId || isDrawingTool(armedTool));
  // An owner that holds the cursor decides when it goes, so Esc stays the pane's.
  const clearableCursor = !!scene?.cursorDate && cursorDate === undefined;

  const placementPanel = (panelId: string) => scene?.panels.find((panel) => panel.id === panelId) ?? null;
  const startKeyboardPlacement = () => {
    if (!scene || !armedTool) return;
    const panel = scene.panels.find((entry) => resolveMeasureAxisDomain(entry) !== null);
    const domain = panel ? resolveMeasureAxisDomain(panel) : null;
    const date = keyboardCursorDateRef.current ?? resolveAdjacentCompositeCursorDate(scene, null, -1);
    if (!panel || !domain || !date) return;
    const time = date.getTime();
    const value = resolveMeasureValueAt(panel, time) ?? unprojectCompositeValue(0.5, domain);
    if (value === null) return;
    const anchor = { time, value };
    onActivate?.();
    if (isDrawingTool(armedTool)) setSelectedDrawingId(null);
    setKeyboardPlacement({ kind: armedTool, panelId: panel.id, start: anchor, end: anchor, path: [anchor], freeValue: false });
    keyboardCursorDateRef.current = date;
    updateCursor(date);
  };
  /** Moves the end to a new bar, following the series until Up or Down set a level. */
  const moveKeyboardPlacement = (
    placement: KeyboardToolPlacement,
    move: { time: number } | { level: 1 | -1 },
  ): KeyboardToolPlacement | null => {
    const panel = placementPanel(placement.panelId);
    const domain = panel ? resolveMeasureAxisDomain(panel) : null;
    if (!panel || !domain) return null;
    let { time, value } = placement.end;
    let freeValue = placement.freeValue;
    if ("level" in move) {
      // Half a row per press: fine enough to reach a wick, quick enough to cross the plot.
      const step = 1 / (2 * Math.max(panel.height - 1, 1));
      const ratio = projectCompositeValue(value, domain) ?? 0.5;
      value = unprojectCompositeValue(Math.max(0, Math.min(1, ratio - move.level * step)), domain) ?? value;
      freeValue = true;
    } else {
      time = move.time;
      if (!freeValue) value = resolveMeasureValueAt(panel, time) ?? value;
    }
    const end = { time, value };
    return { ...placement, end, path: [...placement.path, end], freeValue };
  };
  const finishKeyboardPlacement = () => {
    const placement = keyboardPlacement;
    setKeyboardPlacement(null);
    // A placement that never left its anchor spans nothing, like a click.
    if (!placement || placement.start.time === placement.end.time) return;
    if (placement.kind === "zoom") {
      if (!navigationFrame) return;
      const range = resolveZoomTimeRange(placement.start.time, placement.end.time, navigationFrame.minimumSpanMs);
      if (range) setViewportRange(range);
      return;
    }
    if (!isDrawingTool(placement.kind)) return;
    const points = placement.kind === "pencil"
      ? placement.path.filter((point, index, path) => (
        index === 0 || point.time !== path[index - 1]!.time || point.value !== path[index - 1]!.value
      ))
      : [placement.start, placement.end];
    if (points.length < 2) return;
    addDrawing({ id: nextDrawingId(), panelId: placement.panelId, points, color: drawColor });
  };
  const stepLegend = (direction: -1 | 1) => {
    onActivate?.();
    setLegendKeyboardIndex((current) => (
      current === null
        ? direction > 0 ? 0 : visibleLegendSeries.length - 1
        : (current + direction + visibleLegendSeries.length) % visibleLegendSeries.length
    ));
  };
  const toggleLegendEntry = () => {
    if (!legendEntry || !legendEntryToggleable) return;
    onActivate?.();
    onToggleSeries?.(legendEntry.id);
  };
  const stepDrawing = (direction: -1 | 1) => {
    if (drawings.length === 0) return;
    const index = drawings.findIndex((drawing) => drawing.id === selectedDrawingId);
    const next = index < 0
      ? direction > 0 ? 0 : drawings.length - 1
      : (index + direction + drawings.length) % drawings.length;
    setSelectedDrawingId(drawings[next]!.id);
  };
  const keyboardToolDrag = useMemo<KeyboardToolDrag | null>(() => {
    if (!keyboardPlacement || !scene) return null;
    const panel = scene.panels.find((entry) => entry.id === keyboardPlacement.panelId);
    const domain = panel ? resolveMeasureAxisDomain(panel) : null;
    if (!panel || !domain) return null;
    const project = (point: ChartDrawingPoint) => {
      const xRatio = projectCompositeTimestamp(scene.timeScale, point.time)?.ratio;
      const yRatio = projectCompositeValue(point.value, domain);
      return typeof xRatio === "number" && yRatio !== null ? { xRatio, yRatio } : null;
    };
    const start = project(keyboardPlacement.start);
    const end = project(keyboardPlacement.end);
    if (!start || !end) return null;
    return {
      panelId: panel.id,
      start: keyboardPlacement.start,
      end: keyboardPlacement.end,
      drag: {
        kind: keyboardPlacement.kind,
        startXRatio: start.xRatio,
        startYRatio: start.yRatio,
        endXRatio: end.xRatio,
        endYRatio: end.yRatio,
        path: keyboardPlacement.path.flatMap((point) => {
          const projected = project(point);
          return projected ? [projected] : [];
        }),
      },
    };
  }, [keyboardPlacement, scene]);

  // Scoped, so the chart sees its keys before an older pane or stack handler
  // (Backspace back, Esc close) whichever mounted first; a dialog opened over
  // it is a newer scope and still comes first.
  useShortcut((event) => {
    if (!keyboardActive) return;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (toolsActive && armedTool && isPlainKey(event, "return", "enter") && scene) {
      consume();
      if (keyboardPlacement) finishKeyboardPlacement();
      else startKeyboardPlacement();
      return;
    }
    if (keyboardPlacement && (isPlainKey(event, "escape") || isPlainKey(event, "backspace"))) {
      consume();
      setKeyboardPlacement(null);
      return;
    }
    if (keyboardPlacement && keyboardPlacement.kind !== "zoom" && isPlainKey(event, "up", "down")) {
      consume();
      const level = event.name === "up" ? 1 : -1;
      setKeyboardPlacement((current) => current && moveKeyboardPlacement(current, { level }));
      return;
    }
    if (isPlainKey(event, "[", "]") && (drawingKeysActive || legendKeysActive)) {
      consume();
      const direction = event.name === "[" ? -1 : 1;
      if (drawingKeysActive) stepDrawing(direction);
      else stepLegend(direction);
      return;
    }
    if (isPlainKey(event, "space") && legendKeysActive && legendEntryToggleable) {
      consume();
      toggleLegendEntry();
      return;
    }
    if (isPlainKey(event, "escape") && toolsActive && (armedTool || selectedDrawingId)) {
      consume();
      setArmedTool(null);
      setSelectedDrawingId(null);
      return;
    }
    if (isPlainKey(event, "escape") && legendKeysActive && legendKeyboardIndex !== null && !clearableCursor) {
      consume();
      setLegendKeyboardIndex(null);
      return;
    }
    const interaction = resolveCompositeChartInteraction(event);
    if (!interaction) return;
    const cursorInteraction = interaction === "cursor-left"
      || interaction === "cursor-right"
      || interaction === "clear-cursor";
    if (!cursorInteraction && !toolsActive) return;
    if (
      (interaction === "clear-cursor" && !clearableCursor)
      || ((interaction === "arm-measure"
        || interaction === "arm-zoom"
        || interaction === "arm-line"
        || interaction === "arm-pencil") && !scene)
      || (interaction === "delete-drawing" && !canDeleteDrawing)
      || (interaction === "cycle-colour" && !isDrawingTool(armedTool) && !selectedDrawingId)
      // A read-only chart leaves the arrows to a focused tab strip in its pane;
      // a chart you pan and draw on keeps them, with h/l for the tabs.
      || ((interaction === "cursor-left" || interaction === "cursor-right") && (!scene || (arrowsClaimed && !navigable)))
      || ((interaction === "zoom-in"
        || interaction === "zoom-out"
        || interaction === "pan-left"
        || interaction === "pan-right") && !navigationFrame)
    ) {
      return;
    }
    consume();
    switch (interaction) {
      case "arm-measure":
      case "arm-zoom":
      case "arm-line":
      case "arm-pencil":
        onActivate?.();
        armTool(ARMED_TOOL_BY_INTERACTION[interaction]);
        return;
      case "delete-drawing":
        removeDrawing();
        return;
      case "cycle-colour":
        pickDrawColor(nextDrawingColor(drawColor));
        return;
      case "clear-cursor":
        keyboardCursorDateRef.current = null;
        updateCursor(null);
        return;
      case "cursor-left":
      case "cursor-right": {
        const nextDate = resolveAdjacentCompositeCursorDate(
          scene!,
          keyboardCursorDateRef.current,
          interaction === "cursor-left" ? -1 : 1,
        );
        keyboardCursorDateRef.current = nextDate;
        updateCursor(nextDate);
        if (nextDate && keyboardPlacement) {
          const time = nextDate.getTime();
          setKeyboardPlacement((current) => current && moveKeyboardPlacement(current, { time }));
        }
        return;
      }
      case "pan-left":
        panViewportByRatio(COMPOSITE_KEYBOARD_PAN_RATIO);
        return;
      case "pan-right":
        panViewportByRatio(-COMPOSITE_KEYBOARD_PAN_RATIO);
        return;
      case "reset":
        resetViewport();
        return;
      case "zoom-in":
        zoomViewport(COMPOSITE_ZOOM_STEP_FACTOR);
        return;
      case "zoom-out":
        zoomViewport(1 / COMPOSITE_ZOOM_STEP_FACTOR);
    }
  }, { enabled: keyboardActive, scope: keyboardId });

  // The keys a mode adds show where they act: Enter with a tool in hand, Space
  // on a legend entry. Everything else the chart answers is in the pane menu.
  // Footer and menu entries outlive the render that registered them, so they
  // call through to this render's actions.
  const chartActions = {
    start: startKeyboardPlacement,
    finish: finishKeyboardPlacement,
    toggleLegend: toggleLegendEntry,
    stepLegend,
    stepDrawing,
    removeDrawing,
    cycleColour: () => pickDrawColor(nextDrawingColor(drawColor)),
    reset: resetViewport,
    arm: (tool: ChartToolKind) => {
      onActivate?.();
      armTool(tool);
    },
  };
  const chartActionsRef = useRef(chartActions);
  chartActionsRef.current = chartActions;
  const armedHints = armedTool ? KEYBOARD_TOOL_HINTS[armedTool] : null;
  const placing = !!keyboardPlacement;
  const legendEntryVisible = !!legendEntry && visibleSeriesIds.has(legendEntry.id);
  const resettable = !!activeUserViewport;
  usePaneFooter(keyboardId, () => {
    if (!keyboardActive || !scene) return null;
    const hints: PaneHint[] = [];
    if (toolsActive && armedHints) {
      hints.push(placing
        ? { id: "chart-tool", key: "Enter", label: armedHints.finish, title: armedHints.finishTitle, onPress: () => chartActionsRef.current.finish() }
        : { id: "chart-tool", key: "Enter", label: armedHints.start, title: armedHints.startTitle, onPress: () => chartActionsRef.current.start() });
    }
    if (legendKeysActive && legendEntryToggleable) {
      hints.push({
        id: "chart-series",
        key: "Space",
        label: legendEntryVisible ? "hide" : "show",
        title: legendEntryVisible ? "Hide Series" : "Show Series",
        onPress: () => chartActionsRef.current.toggleLegend(),
      });
    }
    const menu: ContextMenuItem[] = [];
    if (toolsActive) {
      for (const tool of CHART_TOOL_MENU) {
        menu.push({
          id: `chart-tool-${tool.kind}`,
          label: tool.label,
          accelerator: tool.accelerator,
          checked: armedTool === tool.kind,
          onSelect: () => chartActionsRef.current.arm(tool.kind),
        });
      }
      if (drawingKeysActive) {
        menu.push({ id: "chart-drawing-next", label: "Next Drawing", accelerator: "]", onSelect: () => chartActionsRef.current.stepDrawing(1) });
      }
      if (canDeleteDrawing) {
        menu.push({ id: "chart-drawing-delete", label: "Delete Drawing", accelerator: "Backspace", onSelect: () => chartActionsRef.current.removeDrawing() });
      }
      if (isDrawingTool(armedTool) || selectedDrawingId) {
        menu.push({
          id: "chart-drawing-colour",
          label: "Drawing Colour",
          accelerator: "c",
          onSelect: () => chartActionsRef.current.cycleColour(),
        });
      }
      if (resettable) menu.push({ id: "chart-reset", label: "Reset Zoom", accelerator: "0", onSelect: () => chartActionsRef.current.reset() });
    }
    if (legendKeysActive && anyLegendToggleable && !drawingKeysActive) {
      menu.push({ id: "chart-series-next", label: "Next Series", accelerator: "]", onSelect: () => chartActionsRef.current.stepLegend(1) });
    }
    return { order: 10, hints, menu };
  }, [
    armedHints,
    anyLegendToggleable,
    armedTool,
    canDeleteDrawing,
    drawingKeysActive,
    keyboardActive,
    legendEntryToggleable,
    legendEntryVisible,
    legendKeysActive,
    placing,
    resettable,
    !!scene,
    selectedDrawingId,
    toolsActive,
  ]);

  const leftPadding = leftAxisWidth + (leftAxisWidth ? axisGap : 0);
  const rightPadding = rightAxisWidth + (rightAxisWidth ? axisGap : 0);
  const timeAxisLayout = scene && showTimeAxis
    ? buildCompositeTimeAxisLayout(scene, plotWidth)
    : null;
  const emptyTimeAxisLayout = !scene && showTimeAxis && effectiveViewport
    ? buildCompositeViewportTimeAxisLayout(effectiveViewport, plotWidth)
    : null;

  if (!scene) {
    const emptyPlotHeight = Math.max(0, totalHeight - legendRows - timeAxisRows - xMarkerRows);
    return (
      <Box
        flexDirection="column"
        width={totalWidth}
        height={totalHeight}
        overflow="hidden"
        data-gloom-role="composite-chart"
      >
        {legendRows > 0 && legendAccessory ? (
          <CompositeLegend
            scene={null}
            series={[]}
            visibleSeriesIds={new Set()}
            width={totalWidth}
            accessory={legendAccessory}
            accessoryWidth={legendAccessoryWidth}
            formatValue={formatValue}
            showLatestChangePercent={showLatestChangePercent}
            onActivate={onActivate}
            onToggleSeries={onToggleSeries}
            isSeriesToggleable={isSeriesToggleable}
            keyboardIndex={legendKeyboardIndex}
          />
        ) : null}
        {emptyPlotHeight > 0 ? (
          <Box flexDirection="row" width={totalWidth} height={emptyPlotHeight}>
            {leftPadding > 0 ? <Box width={leftPadding} /> : null}
            <ChartSurface
              width={plotWidth}
              height={emptyPlotHeight}
              alignItems="center"
              justifyContent="center"
              onMouseScroll={interactive && navigable && navigationFrame ? handleEmptyMouseScroll : undefined}
              cursor={interactive && navigable && navigationFrame ? "grab" : undefined}
              data-gloom-interactive={interactive && navigable && navigationFrame ? "true" : undefined}
              data-gloom-role="composite-chart-empty"
              data-gloom-label={emptyMessage}
            >
              <Text fg={resolvedColors.textDim}>{emptyMessage}</Text>
            </ChartSurface>
            {rightPadding > 0 ? <Box width={rightPadding} /> : null}
          </Box>
        ) : null}
        {emptyTimeAxisLayout ? (
          <Box flexDirection="row" width={totalWidth} height={1}>
            {leftPadding > 0 ? <Box width={leftPadding} /> : null}
            <StaticXAxisLabels
              labels={[emptyTimeAxisLayout.text]}
              positionedLabels={emptyTimeAxisLayout.ticks}
              width={plotWidth}
              color={resolvedColors.textDim}
            />
            {rightPadding > 0 ? <Box width={rightPadding} /> : null}
          </Box>
        ) : null}
      </Box>
    );
  }

  const timeAxisCursorColumn = scene.cursorXRatio === null
    ? null
    : scene.cursorXRatio * Math.max(plotWidth - 1, 0);
  const timeAxisCursorPixelX = timeAxisCursorColumn === null
    ? null
    : timeAxisCursorColumn * cellWidthPx;
  const timeAxisCursorLabel = xAxis?.formatCursor && scene.cursorXRatio !== null
    ? xAxis.formatCursor(scene.cursorXRatio)
    : scene.cursorDate
      ? formatCompositeTimeAxisDate(scene.cursorDate, scene.startTime, scene.endTime)
      : null;
  // The crosshair labels the moving end, so the axis only adds the anchor.
  const timeAxisMarkers = toolSpan
    ? [{
      ratio: toolSpan.startXRatio,
      label: formatCompositeTimeAxisDate(
        new Date(toolSpan.startTime),
        scene.startTime,
        scene.endTime,
      ),
      color: toolSpan.color,
    }]
    : undefined;
  return (
    <Box
      flexDirection="column"
      width={totalWidth}
      height={totalHeight}
      overflow="hidden"
      // The tool overlay anchors here; without it the desktop pins it to the page.
      position="relative"
      data-gloom-role="composite-chart"
    >
      {showLegend ? (
        <CompositeLegend
          scene={scene}
          series={visibleLegendSeries}
          visibleSeriesIds={visibleSeriesIds}
          width={totalWidth}
          accessory={legendAccessory}
          accessoryWidth={legendAccessoryWidth}
          formatValue={formatValue}
          showLatestChangePercent={showLatestChangePercent}
          onActivate={onActivate}
          onToggleSeries={onToggleSeries}
          isSeriesToggleable={isSeriesToggleable}
          keyboardIndex={legendKeyboardIndex}
        />
      ) : null}
      {interactive && navigable && plotWidth > CHART_TOOLBAR_WIDTH + 4 ? (
        <ChartToolbar
          armedTool={armedTool}
          isDesktopWeb={isDesktopWeb}
          left={leftPadding}
          top={legendRows}
          drawColor={drawColor}
          showColors={isDrawingTool(armedTool) || !!selectedDrawingId}
          onArmTool={(tool) => {
            onActivate?.();
            armTool(tool);
          }}
          onPickColor={(color) => {
            onActivate?.();
            pickDrawColor(color);
          }}
        />
      ) : null}
      {paneInstanceId ? (
        <ChartDrawingStore
          paneInstanceId={paneInstanceId}
          drawings={drawings}
          onRestore={setDrawings}
        />
      ) : null}
      {scene.panels.map((panel) => (
        <CompositePanelSurface
          key={panel.id}
          panel={panel}
          scene={scene}
          plotWidth={plotWidth}
          leftAxisWidth={leftAxisWidth}
          rightAxisWidth={rightAxisWidth}
          axisGap={axisGap}
          colors={resolvedColors}
          interactive={interactive}
          navigable={navigable}
          formatAxisValue={formatAxisValue}
          remoteKind={remoteKind}
          viewport={effectiveViewport!}
          frame={navigationFrame!}
          armedTool={armedTool}
          drawings={drawings}
          selectedDrawingId={selectedDrawingId}
          drawColor={drawColor}
          onDraw={addDrawing}
          onEditDrawing={editDrawing}
          onSelectDrawing={setSelectedDrawingId}
          onActivate={onActivate}
          onCursorDateChange={updateCursor}
          onPanViewport={panViewport}
          onZoomViewport={zoomViewport}
          onSetViewport={setViewportRange}
          onToolSpanChange={setToolSpan}
          keyboardToolDrag={keyboardToolDrag?.panelId === panel.id ? keyboardToolDrag : null}
          onPointerPress={cancelKeyboardPlacement}
          showTextFallback={showTextFallback}
        />
      ))}
      {watermarkScale ? (
        // Hidden until a screenshot reveals it (see utils/screenshot-watermark).
        // Above the opaque bitmaps, below drawings, crosshair and readouts.
        <Box
          position="absolute"
          left={leftPadding}
          top={legendRows}
          width={plotWidth}
          height={plotHeight}
          zIndex={5}
          alignItems="center"
          justifyContent="center"
          data-gloom-role={CHART_WATERMARK_ROLE}
        >
          <AsciiText text="Gloomberb" font="wordmark" scale={watermarkScale} color={resolvedColors.textDim} />
        </Box>
      ) : null}
      {xMarkers.length > 0 ? (
        <Box
          position="absolute"
          left={leftPadding}
          top={legendRows}
          width={plotWidth}
          height={plotHeight}
          zIndex={12}
          style={isDesktopWeb ? { pointerEvents: "none" } : undefined}
        >
          <StaticXMarkerOverlay
            markers={xMarkers}
            width={plotWidth}
            height={plotHeight}
            fallbackColor={resolvedColors.textDim}
          />
        </Box>
      ) : null}
      {timeAxisLayout ? (
        <Box flexDirection="row" width={totalWidth} height={1}>
          {leftPadding > 0 ? <Box width={leftPadding} /> : null}
          <StaticXAxisLabels
            labels={xAxis?.ticks ? [] : xAxis?.labels ? [...xAxis.labels] : [timeAxisLayout.text]}
            positionedLabels={xAxis?.ticks ?? (xAxis?.labels ? undefined : timeAxisLayout.ticks)}
            width={plotWidth}
            color={resolvedColors.textDim}
            cursorColumn={timeAxisCursorColumn}
            cursorPixelX={timeAxisCursorPixelX}
            cursorLabel={timeAxisCursorLabel}
            cursorColor={resolvedColors.crosshair}
            cursorBackgroundColor={resolvedColors.background}
            extraMarkers={timeAxisMarkers}
          />
          {rightPadding > 0 ? <Box width={rightPadding} /> : null}
        </Box>
      ) : null}
      {xMarkerRows > 0 ? (
        <Box flexDirection="row" width={totalWidth} height={1}>
          {leftPadding > 0 ? <Box width={leftPadding} /> : null}
          <StaticXMarkerLabels
            markers={xMarkers}
            width={plotWidth}
            fallbackColor={resolvedColors.textDim}
          />
          {rightPadding > 0 ? <Box width={rightPadding} /> : null}
        </Box>
      ) : null}
    </Box>
  );
}
