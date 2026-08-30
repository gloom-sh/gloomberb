import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
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
import { useOptionalPaneInstanceId, usePaneSettingValue } from "../../../state/app/context";
import { colors as themeColors, hoverBg } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { formatPercentRaw } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { truncateWithEllipsis } from "../../../utils/text-wrap";
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
} from "../static/chart/bitmap";
import { StaticXAxisLabels } from "../static/chart/axis-overlays";
import { PriceAxisLabels } from "../price-axis-labels";
import {
  compositeAxisTicks,
  formatCompositeAxisValue,
  formatCompositeCursorDate,
  formatCompositeCursorValue,
  formatCompositePointDetails,
  formatCompositeSeriesValue,
  formatCompositeTimeAxisDate,
} from "./format";
import {
  COMPOSITE_KEYBOARD_PAN_RATIO,
  COMPOSITE_ZOOM_STEP_FACTOR,
  clampCompositeViewport,
  resolveCompositeChartInteraction,
  resolveCompositeMinimumSpanMs,
  resolveCompositeNavigationBounds,
  resolveCompositeWheelPanRatio,
  shouldResetCompositeViewport,
  type CompositeViewportRange,
} from "./interactions";
import { buildCompositeColumnLayout, type CompositeColumnLayout } from "./column-layout";
import {
  CompositeChartEngine,
  createCompositePanelPaintSource,
  type CompositeAxisDomains,
} from "./engine";
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
  hitTestDrawings,
  isDrawingTool,
  nextDrawingColor,
  parseChartDrawings,
  resolveDrawingFromDrag,
  resolveZoomBoxRange,
  shiftDrawing,
  summarizeMeasure,
  summarizeZoomSelection,
  type ChartDrawing,
  type ChartToolDrag,
  type ChartToolKind,
} from "./tools";
import { unprojectCompositeTimestamp } from "./time-scale";
import {
  buildCompositeChartScene,
  projectCompositeValue,
  resolveAdjacentCompositeCursorDate,
  resolveCompositeCursorDate,
  unprojectCompositeValue,
} from "./scene";
import {
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
  CompositePanelScene,
} from "./types";

const LEGEND_WHEEL_DELTA_PER_CELL = 8;

function isVerticalWheelDirection(
  direction: "up" | "down" | "left" | "right",
): direction is "up" | "down" {
  return direction === "up" || direction === "down";
}

function renderPanelBitmap(
  panel: CompositePanelScene,
  bitmapSize: StaticChartBitmapSize,
  colors: CompositeChartColors,
): NativeChartBitmap {
  return renderCompositePanelBitmap(panel, {
    pixelWidth: bitmapSize.pixelWidth,
    pixelHeight: bitmapSize.pixelHeight,
    colors,
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
  return useMemo(() => (
    isDesktopWeb || !bitmapSize ? null : renderPanelBitmap(panel, bitmapSize, colors)
  ), [bitmapSize, colors, isDesktopWeb, panel]);
}

function resolvePanelCrosshair(
  panel: CompositePanelScene,
  columnLayout: CompositeColumnLayout,
  surface: { width: number; height: number } | null,
  cursorXRatio: number | null,
  cursorYRatio: number | null,
  color: string,
): ChartSurfaceProps["crosshair"] {
  if (!surface || cursorXRatio === null || cursorYRatio === null) return null;
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
        pixelY: cursorPoint.yRatio * Math.max(surface.height - 1, 0),
        color: series.source.color,
      }]
      : [];
  });
  return {
    pixelX: cursorXRatio * Math.max(surface.width - 1, 0),
    pixelY: cursorYRatio * Math.max(surface.height - 1, 0),
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
): string | null {
  const domain = panel.axes[side];
  if (!domain || cursorYRatio === null) return null;
  const value = unprojectCompositeValue(cursorYRatio, domain);
  return value === null ? null : formatCompositeCursorValue(value, domain);
}

const MINIMUM_AXIS_LABEL_WIDTH = 3;

/**
 * Cells the gutter needs for its own labels. Ticks cover the axis itself, and a
 * mid-domain sample covers the wider cursor readout that lands between them.
 */
function compositeAxisLabelWidth(domain: CompositeAxisDomain | undefined): number {
  if (!domain) return 0;
  const labels = compositeAxisTicks(domain).map((tick) => tick.label);
  labels.push(formatCompositeAxisValue((domain.min + domain.max) / 2, domain));
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
  color: string;
}

const ARMED_TOOL_BY_INTERACTION = {
  "arm-measure": "measure",
  "arm-zoom": "zoom",
  "arm-line": "line",
  "arm-pencil": "pencil",
} as const satisfies Record<string, ChartToolKind>;

const COMPOSITE_PANEL_ROLE = "composite-chart-panel";

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
  engine: CompositeChartEngine;
  panel: CompositePanelScene;
  scene: CompositeChartScene;
  plotWidth: number;
  leftAxisWidth: number;
  rightAxisWidth: number;
  axisGap: number;
  colors: CompositeChartColors;
  interactive: boolean;
  viewport: CompositeViewportRange;
  minimumViewportSpanMs: number;
  armedTool: ChartToolKind | null;
  drawings: readonly ChartDrawing[];
  selectedDrawingId: string | null;
  drawColor: string;
  onDraw: (drawing: ChartDrawing) => void;
  onEditDrawing: (id: string, update: (drawing: ChartDrawing) => ChartDrawing) => void;
  onSelectDrawing: (id: string | null) => void;
  onActivate?: () => void;
  onCursorDateChange: (date: Date | null) => void;
  onPanViewport: (shiftRatio: number, fromViewport?: CompositeViewportRange) => void;
  onZoomViewport: (zoomFactor: number, anchorRatio: number) => void;
  onSetViewport: (range: CompositeViewportRange) => void;
  onToolSpanChange: (span: ChartToolSpan | null) => void;
  showTextFallback: boolean;
}

function CompositePanelSurface({
  engine,
  panel,
  scene,
  plotWidth,
  leftAxisWidth,
  rightAxisWidth,
  axisGap,
  colors,
  interactive,
  viewport,
  minimumViewportSpanMs,
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
  showTextFallback,
}: CompositePanelSurfaceProps) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const { cellHeightPx = 18, cellWidthPx = 8 } = useUiCapabilities();
  const renderer = useNativeRenderer();
  const plotRef = useRef<BoxRenderable | null>(null);
  const [cursorYRatio, setCursorYRatio] = useState<number | null>(null);
  const seriesCursorYRatio = useMemo(
    () => resolveSeriesCursorYRatio(panel, scene),
    [panel, scene],
  );
  const activeCursorYRatio = scene.cursorXRatio === null
    ? null
    : cursorYRatio ?? seriesCursorYRatio;
  const dragRef = useRef<
    | { kind: "pan"; startGlobalX: number; startViewport: CompositeViewportRange }
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
  const [toolDrag, setToolDrag] = useState<ChartToolDrag | null>(null);
  const plotAspect = (plotWidth * cellWidthPx) / Math.max(panel.height * cellHeightPx, 1);
  const bitmapSize = useStaticChartBitmapSize(plotWidth, panel.height);
  const bitmap = useCompositePanelBitmap({ panel, bitmapSize, colors, isDesktopWeb });
  const paintCallbacksRef = useRef({ onActivate, onCursorDateChange });
  paintCallbacksRef.current = { onActivate, onCursorDateChange };
  const activatePaintSource = useCallback(() => paintCallbacksRef.current.onActivate?.(), []);
  const updateScrollCrosshair = useCallback((_date: Date | null, yRatio: number) => {
    setCursorYRatio((current) => current === yRatio ? current : yRatio);
  }, []);
  const commitScrollCrosshair = useCallback((date: Date | null) => {
    paintCallbacksRef.current.onCursorDateChange(date);
  }, []);
  const paintSource = useMemo(() => (
    isDesktopWeb
      ? createCompositePanelPaintSource({
          engine,
          panelId: panel.id,
          colors,
          width: plotWidth * cellWidthPx,
          height: panel.height * cellHeightPx,
          interactive: interactive && armedTool === null,
          onActivate: activatePaintSource,
          onScrollPanFrame: updateScrollCrosshair,
          onScrollPanEnd: commitScrollCrosshair,
        })
      : null
  ), [
    activatePaintSource,
    armedTool,
    cellHeightPx,
    cellWidthPx,
    colors,
    commitScrollCrosshair,
    engine,
    interactive,
    isDesktopWeb,
    panel.height,
    panel.id,
    plotWidth,
    updateScrollCrosshair,
  ]);
  const columnLayout = useMemo(() => buildCompositeColumnLayout(panel), [panel]);
  const crosshairSurface = isDesktopWeb
    ? { width: plotWidth * cellWidthPx, height: panel.height * cellHeightPx }
    : bitmap;
  const crosshair = useMemo(
    () => resolvePanelCrosshair(
      panel,
      columnLayout,
      crosshairSurface,
      scene.cursorXRatio,
      activeCursorYRatio,
      colors.crosshair,
    ),
    [activeCursorYRatio, colors.crosshair, columnLayout, crosshairSurface, panel, scene.cursorXRatio],
  );
  const measureDomain = useMemo(() => resolveMeasureAxisDomain(panel), [panel]);
  const toolReadout = useMemo(() => {
    if (!toolDrag) return null;
    if (toolDrag.kind === "zoom") {
      return {
        direction: "up" as const,
        summary: summarizeZoomSelection(scene, toolDrag),
        startValueLabel: null,
        endValueLabel: null,
      };
    }
    const startValue = measureDomain
      ? unprojectCompositeValue(toolDrag.startYRatio, measureDomain)
      : null;
    const endValue = measureDomain
      ? unprojectCompositeValue(toolDrag.endYRatio, measureDomain)
      : null;
    const startTime = unprojectCompositeTimestamp(scene.timeScale, toolDrag.startXRatio);
    const endTime = unprojectCompositeTimestamp(scene.timeScale, toolDrag.endXRatio);
    return {
      direction: resolveMeasureDirection(startValue, endValue),
      summary: summarizeMeasure({
        startValue,
        endValue,
        startTime,
        endTime,
        bars: countMeasureBars(scene.dates, startTime, endTime),
        domain: measureDomain,
      }),
      startValueLabel: measureDomain && startValue !== null
        ? formatCompositeCursorValue(startValue, measureDomain)
        : null,
      endValueLabel: measureDomain && endValue !== null
        ? formatCompositeCursorValue(endValue, measureDomain)
        : null,
    };
  }, [measureDomain, scene, toolDrag]);
  const toolSummary = toolReadout?.summary ?? null;
  const toolSpan = useMemo(() => {
    if (!toolDrag || !toolSummary) return null;
    return {
      startXRatio: toolDrag.startXRatio,
      endXRatio: toolDrag.endXRatio,
      color: toolDrag.kind === "zoom"
        ? colors.crosshair
        : toolReadout?.direction === "down" ? colors.negative : themeColors.positive,
    };
  }, [colors.crosshair, colors.negative, toolDrag, toolReadout?.direction, toolSummary]);
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
    if (isDesktopWeb || (!toolDrag && panelDrawings.length === 0)) return [bitmap];
    return [drawChartToolOverlay(
      bitmap,
      toolDrag,
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
    bitmap,
    colors.crosshair,
    colors.negative,
    drawColor,
    isDesktopWeb,
    panel,
    panelDrawings,
    scene,
    selectedDrawingId,
    toolDrag,
    toolReadout?.direction,
  ]);
  const vectors = useMemo<ChartSurfaceProps["vectors"]>(() => {
    if (!isDesktopWeb) return null;
    const shapes = buildChartToolVectors({
      scene,
      panel,
      drawings: panelDrawings,
      selectedId: selectedDrawingId,
      drag: toolDrag,
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
    colors.crosshair,
    colors.negative,
    drawColor,
    isDesktopWeb,
    panel,
    panelDrawings,
    scene,
    selectedDrawingId,
    toolDrag,
    toolReadout?.direction,
  ]);
  const textLines = useMemo(
    () => isDesktopWeb || !showTextFallback
      ? []
      : renderCompositePanelText(panel, plotWidth, scene.cursorXRatio, activeCursorYRatio),
    [activeCursorYRatio, isDesktopWeb, panel, plotWidth, scene.cursorXRatio, showTextFallback],
  );
  const leftAxisLabels = useMemo(
    () => axisLabelRows(
      renderCompositeAxisText(panel.axes.left, panel.height, leftAxisWidth, "left"),
    ),
    [leftAxisWidth, panel],
  );
  const rightAxisLabels = useMemo(
    () => axisLabelRows(
      renderCompositeAxisText(panel.axes.right, panel.height, rightAxisWidth, "right"),
    ),
    [panel, rightAxisWidth],
  );
  const cursorRow = activeCursorYRatio === null
    ? null
    : Math.round(activeCursorYRatio * Math.max(panel.height - 1, 0));
  const cursorPixelY = activeCursorYRatio === null
    ? null
    : activeCursorYRatio * Math.max(panel.height * cellHeightPx - 1, 0);
  const leftCursorLabel = cursorAxisLabel(panel, "left", activeCursorYRatio);
  const rightCursorLabel = cursorAxisLabel(panel, "right", activeCursorYRatio);
  const measureReadout = useMemo(() => {
    if (!toolDrag || !toolReadout?.summary) return null;
    const text = toolReadout.summary;
    const centreX = (toolDrag.startXRatio + toolDrag.endXRatio) / 2;
    const centreY = toolDrag.kind === "zoom"
      ? 0.5
      : (toolDrag.startYRatio + toolDrag.endYRatio) / 2;
    const width = Math.min([...text].length, plotWidth);
    return {
      text,
      width,
      color: toolDrag.kind === "zoom"
        ? colors.text
        : toolReadout.direction === "down" ? colors.negative : themeColors.positive,
      left: leftAxisWidth + (leftAxisWidth ? axisGap : 0)
        + Math.max(0, Math.min(plotWidth - width, Math.round(centreX * plotWidth - width / 2))),
      top: Math.max(0, Math.min(panel.height - 1, Math.round(centreY * (panel.height - 1)))),
    };
  }, [
    axisGap,
    colors.negative,
    colors.text,
    leftAxisWidth,
    panel.height,
    plotWidth,
    toolDrag,
    toolReadout,
  ]);
  const axisMarkers = useMemo(() => {
    // The crosshair already marks the moving end, so the axes only need the
    // anchor the drag started from.
    if (!toolDrag || toolDrag.kind === "zoom" || !toolReadout?.startValueLabel) return null;
    return {
      yRatio: toolDrag.startYRatio,
      label: toolReadout.startValueLabel,
      color: toolReadout.direction === "down" ? colors.negative : themeColors.positive,
    };
  }, [colors.negative, toolDrag, toolReadout]);
  const buildAxisMarkers = (side: "left" | "right") => {
    if (!axisMarkers || !panel.axes[side]) return undefined;
    const row = Math.round(axisMarkers.yRatio * Math.max(panel.height - 1, 0));
    return [{
      row,
      pixelY: axisMarkers.yRatio * Math.max(panel.height * cellHeightPx - 1, 0),
      label: axisMarkers.label,
      color: axisMarkers.color,
    }];
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
    // Desktop panning belongs to the Canvas pointer path. Falling back here
    // would quantize the drag through terminal-cell mouse coordinates.
    if (isDesktopWeb || !updateCursor(event)) return;
    dragRef.current = {
      kind: "pan",
      startGlobalX: getGlobalMouseX(event, renderer),
      startViewport: viewport,
    };
  }, [
    armedTool,
    drawings,
    isDesktopWeb,
    onActivate,
    onSelectDrawing,
    panel,
    plotAspect,
    pointerRatios,
    renderer,
    scene,
    updateCursor,
    viewport,
  ]);
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
    const deltaCells = getGlobalMouseX(event, renderer) - drag.startGlobalX;
    onPanViewport(deltaCells / Math.max(plotWidth, 1), drag.startViewport);
  }, [
    onEditDrawing,
    onPanViewport,
    panel,
    plotWidth,
    pointerRatios,
    renderer,
    scene,
    updateCursor,
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
    const range = resolveZoomBoxRange(scene, drag, minimumViewportSpanMs);
    if (range) onSetViewport(range);
  }, [drawColor, minimumViewportSpanMs, onDraw, onSetViewport, panel, scene]);
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
  const panFromWheel = useCallback((event: ChartMouseEvent) => {
    const direction = event.scroll?.direction;
    if (!direction) return;
    onActivate?.();
    consumeChartMouseEvent(event);
    const pointerTarget = plotRef.current as unknown as Parameters<typeof getLocalPlotPointer>[1];
    const pointer = getLocalPlotPointer(event, pointerTarget, renderer);
    if (event.modifiers.ctrl && pointer && isVerticalWheelDirection(direction)) {
      const zoomIn = direction === "up";
      const magnitude = Math.min(Math.max(Math.abs(event.scroll?.delta ?? 1), 1), 8);
      const pointerRatio = pointer.cellX / Math.max(plotWidth - 1, 1);
      onZoomViewport(
        zoomIn ? 1 + magnitude * 0.04 : 1 / (1 + magnitude * 0.04),
        pointerRatio,
      );
      updateCursor(event);
      return;
    }
    updateCursor(event);
    onPanViewport(resolveCompositeWheelPanRatio(direction, event.scroll?.delta));
  }, [onActivate, onPanViewport, onZoomViewport, plotWidth, renderer, updateCursor]);

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
        paintSource={paintSource}
        crosshair={crosshair}
        vectors={vectors}
        onMouseMove={interactive ? handleMouseMove : undefined}
        onMouseDown={interactive ? startDrag : undefined}
        onMouseDrag={interactive ? dragViewport : undefined}
        onMouseUp={interactive ? resetDrag : undefined}
        onMouseDragEnd={interactive ? resetDrag : undefined}
        onMouseScroll={interactive ? panFromWheel : undefined}
        onMouseOut={interactive ? clearCursor : undefined}
        cursor={interactive ? toolDrag ? "crosshair" : "grab" : undefined}
        data-gloom-interactive={interactive ? "true" : undefined}
        data-gloom-role={COMPOSITE_PANEL_ROLE}
        data-gloom-label={panel.label ?? panel.id}
      >
        {textLines.map((line, index) => <Text key={index} fg={colors.text}>{line}</Text>)}
      </ChartSurface>
      {rightAxisWidth > 0 ? (
        <>
          <Box width={axisGap} />
          <PriceAxisLabels
            axisLabels={rightAxisLabels}
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
): string {
  if (value === null) return "—";
  return formatValue ? formatValue(value, series) : formatCompositeSeriesValue(value, series);
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
    const fullText = entry.points.length === 0
      ? `${entry.label}${entry.hidden ? "" : " no data"}`
      : `${entry.label} ${legendValue(
        entry,
        cursorValue?.value ?? null,
        formatValue,
      )}${changeText}`;
    const details = formatCompositePointDetails(cursorValue?.point);
    const tooltip = details ? `${fullText} · ${details}` : fullText;
    const textWidth = Math.max(1, Math.min(30, [...fullText].length));
    return {
      entry,
      text: truncateWithEllipsis(fullText, textWidth),
      width: textWidth + 2,
      toggleable,
      tooltip,
    };
  });
  const desiredSeriesWidth = entries.reduce(
    (total, entry, index) => total + entry.width + (index > 0 ? 1 : 0),
    0,
  );
  const resolvedAccessoryWidth = accessory
    ? Math.max(1, Math.min(width, Math.floor(accessoryWidth ?? 14)))
    : 0;
  const reservedAccessoryGap = accessory && width > resolvedAccessoryWidth ? 1 : 0;
  // The cursor date lives on the time axis, where the crosshair points at it.
  const widthBeforeAccessory = Math.max(0, width - resolvedAccessoryWidth - reservedAccessoryGap);
  const seriesWidth = Math.min(desiredSeriesWidth, widthBeforeAccessory);
  const accessorySpacerWidth = accessory
    ? Math.max(reservedAccessoryGap, width - seriesWidth - resolvedAccessoryWidth)
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
      overflow="visible"
      zIndex={20}
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
  viewportResetKey,
  colors,
  interactive = true,
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
  const { cellWidthPx = 8, pixelRatio = 1 } = useUiCapabilities();
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const showTextFallback = useShowChartTextFallback();
  const [internalCursorDate, setInternalCursorDate] = useState<Date | null>(null);
  const [legendKeyboardIndex, setLegendKeyboardIndex] = useState<number | null>(null);
  const [toolSpan, setToolSpan] = useState<ChartToolSpan | null>(null);
  const [armedTool, setArmedTool] = useState<ChartToolKind | null>(null);
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
  const viewportResetSequenceRef = useRef(0);
  if (viewportResetKey === undefined && shouldResetCompositeViewport(
    previousAuthoredViewportRef.current,
    viewport ?? null,
  )) {
    viewportResetSequenceRef.current += 1;
  }
  previousAuthoredViewportRef.current = viewport ?? null;
  const engineResetKey = viewportResetKey === undefined
    ? `viewport:${viewportResetSequenceRef.current}`
    : `authored:${viewportResetKey}`;
  const engineRef = useRef<CompositeChartEngine | null>(null);
  if (!engineRef.current) engineRef.current = new CompositeChartEngine();
  const engine = engineRef.current;
  const engineSnapshot = useSyncExternalStore(
    engine.subscribeState,
    engine.getSnapshot,
    engine.getSnapshot,
  );
  const navigationAnchorViewport = engine.hasResetKey(engineResetKey) && !engine.isDragging()
    ? engineSnapshot.interactionViewport ?? viewport
    : viewport;
  const navigationBounds = useMemo(
    () => resolveCompositeNavigationBounds(
      visibleSeries,
      navigationAnchorViewport,
      { historicalPaddingRatio: allowHistoricalBackfill ? 1 : 0 },
    ),
    [allowHistoricalBackfill, navigationAnchorViewport, visibleSeries],
  );
  const initialViewport = useMemo(() => (
    navigationBounds
      ? viewport
        ? clampCompositeViewport(viewport, navigationBounds)
        : navigationBounds
      : null
  ), [navigationBounds, viewport]);
  const effectiveViewport = engine.hasResetKey(engineResetKey)
    ? engineSnapshot.viewport ?? initialViewport
    : initialViewport;
  const minimumViewportSpanMs = useMemo(
    () => navigationBounds ? resolveCompositeMinimumSpanMs(visibleSeries, navigationBounds) : 1,
    [navigationBounds, visibleSeries],
  );
  // Sticky while armed: the toolbar chip shows which tool owns the drag, and a
  // one-shot tool would blink off before the user could see it.
  const armTool = useCallback((tool: ChartToolKind | null) => {
    setArmedTool((current) => current === tool ? null : tool);
    if (tool === null) setSelectedDrawingId(null);
  }, []);
  const legendRows = showLegend && (visibleSeries.length > 0 || legendAccessory)
    ? 1
    : 0;
  const timeAxisRows = showTimeAxis ? 1 : 0;
  const panelCount = new Set(visibleSeries.map((entry) => entry.panelId)).size;
  const lastTickKey = visibleSeries.map((entry) => {
    const last = entry.points.at(-1);
    if (!last) return entry.id;
    return `${entry.id}:${last.date.getTime()}:${last.close ?? ""}:${last.value ?? ""}:${entry.latestChangePercent ?? ""}`;
  }).join("|");
  const plotHeight = Math.max(panelCount, totalHeight - legendRows - timeAxisRows);
  const resolvedColors = useMemo<CompositeChartColors>(() => ({
    background: colors?.background ?? activeThemeColors.bg,
    grid: colors?.grid ?? activeThemeColors.border,
    crosshair: colors?.crosshair ?? activeThemeColors.borderFocused,
    text: colors?.text ?? activeThemeColors.text,
    textDim: colors?.textDim ?? activeThemeColors.textDim,
    negative: colors?.negative ?? activeThemeColors.negative,
  }), [activeThemeColors, colors]);
  const projectedScene = useMemo(() => {
    // lastTickKey busts this memo when a live tick mutates series identity in place.
    void lastTickKey;
    return buildCompositeChartScene(visibleSeries, panels, {
      width: 1,
      height: Math.max(panelCount, 1),
      viewport: effectiveViewport ?? undefined,
      timelineSeries: marketTimelineSeries,
    });
  }, [effectiveViewport, lastTickKey, marketTimelineSeries, panelCount, panels, visibleSeries]);
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
  const computedAxisWidth = useMemo(() => Math.min(
    maximumAxisWidth,
    Math.max(
      MINIMUM_AXIS_LABEL_WIDTH,
      ...(projectedScene?.panels ?? []).flatMap((panel) => [
        compositeAxisLabelWidth(panel.axes.left),
        compositeAxisLabelWidth(panel.axes.right),
      ]),
    ),
  ), [maximumAxisWidth, projectedScene]);
  const restingAxisWidthRef = useRef(computedAxisWidth);
  if (!engine.isDragging()) restingAxisWidthRef.current = computedAxisWidth;
  const resolvedAxisWidth = engine.isDragging() ? restingAxisWidthRef.current : computedAxisWidth;
  const leftAxisWidth = hasLeftAxis ? resolvedAxisWidth : 0;
  const rightAxisWidth = hasRightAxis ? resolvedAxisWidth : 0;
  const axisGap = resolvedAxisWidth > 0 ? 1 : 0;
  const horizontalReserved = leftAxisWidth + rightAxisWidth
    + axisGap * ((leftAxisWidth ? 1 : 0) + (rightAxisWidth ? 1 : 0));
  const plotWidth = Math.max(1, totalWidth - horizontalReserved);
  const downsampleWidth = Math.max(
    1,
    Math.round(plotWidth * cellWidthPx * Math.max(1, pixelRatio)),
  );
  const resolvedCursorTimestamp = resolvedCursorDate?.getTime() ?? null;
  const normalizedCursorTimestamp = resolvedCursorTimestamp !== null && Number.isFinite(resolvedCursorTimestamp)
    ? resolvedCursorTimestamp
    : null;
  const buildEngineScene = useCallback((
    nextViewport: CompositeViewportRange,
    axisDomains?: CompositeAxisDomains,
    widthScale = 1,
    cursorDate?: Date | null,
  ) => {
    // lastTickKey busts the builder when a live source mutates in place.
    void lastTickKey;
    const cursorTimestamp = cursorDate === undefined
      ? normalizedCursorTimestamp
      : cursorDate?.getTime() ?? null;
    const next = buildCompositeChartScene(visibleSeries, panels, {
      width: Math.max(1, Math.round(plotWidth * widthScale)),
      height: plotHeight,
      cursorDate: cursorTimestamp === null ? null : new Date(cursorTimestamp),
      viewport: nextViewport,
      timelineSeries: marketTimelineSeries,
      axisDomains,
    });
    return next
      ? downsampleCompositeChartScene(next, Math.max(1, Math.round(downsampleWidth * widthScale)))
      : null;
  }, [
    downsampleWidth,
    lastTickKey,
    marketTimelineSeries,
    normalizedCursorTimestamp,
    panels,
    plotHeight,
    plotWidth,
    visibleSeries,
  ]);
  const fallbackScene = useMemo(() => (
    effectiveViewport ? buildEngineScene(effectiveViewport) : null
  ), [buildEngineScene, effectiveViewport]);
  const engineConfig = useMemo(() => (
    initialViewport && navigationBounds
      ? {
          resetKey: engineResetKey,
          initialViewport,
          navigationBounds,
          series: marketTimelineSeries,
          allowHistoricalBackfill,
          buildScene: buildEngineScene,
          onCommit: (
            next: CompositeViewportRange | null,
            interaction: "pan" | "reset" | "sync" | "zoom",
          ) => onViewportChange?.(next, interaction),
        }
      : null
  ), [
    allowHistoricalBackfill,
    buildEngineScene,
    engineResetKey,
    initialViewport,
    marketTimelineSeries,
    navigationBounds,
    onViewportChange,
  ]);
  useLayoutEffect(() => {
    if (engineConfig) engine.configure(engineConfig);
  }, [engine, engineConfig]);
  const scene = engineConfig && engine.isConfigured(engineConfig)
    ? engineSnapshot.scene
    : fallbackScene;
  const liveViewport = engineConfig && engine.isConfigured(engineConfig)
    ? engineSnapshot.viewport ?? effectiveViewport
    : effectiveViewport;
  const zoomViewport = useCallback((zoomFactor: number, anchorRatio = 1) => {
    engine.zoom(zoomFactor, anchorRatio, minimumViewportSpanMs);
  }, [engine, minimumViewportSpanMs]);
  const panViewport = useCallback((
    shiftRatio: number,
    fromViewport?: CompositeViewportRange,
  ) => {
    engine.pan(shiftRatio, fromViewport);
  }, [engine]);
  const setViewportRange = useCallback((range: CompositeViewportRange) => {
    engine.setViewport(range);
  }, [engine]);
  const resetViewport = useCallback(() => engine.reset(), [engine]);
  const handleEmptyMouseScroll = useCallback((event: ChartMouseEvent) => {
    const direction = event.scroll?.direction;
    if (!interactive || !navigationBounds || !direction) return;
    onActivate?.();
    consumeChartMouseEvent(event);
    if (event.modifiers.ctrl && isVerticalWheelDirection(direction)) {
      const zoomIn = direction === "up";
      if (!zoomIn) {
        resetViewport();
        return;
      }
      const magnitude = Math.min(Math.max(Math.abs(event.scroll?.delta ?? 1), 1), 8);
      zoomViewport(1 + magnitude * 0.04, 0.5);
      return;
    }
    panViewport(resolveCompositeWheelPanRatio(direction, event.scroll?.delta));
  }, [
    interactive,
    navigationBounds,
    onActivate,
    panViewport,
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

  useShortcut((event) => {
    if (!focused || !interactive) return;
    if (isPlainKey(event, "[", "]") && visibleLegendSeries.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.name === "[" ? -1 : 1;
      setLegendKeyboardIndex((current) => (
        current === null
          ? direction > 0 ? 0 : visibleLegendSeries.length - 1
          : (current + direction + visibleLegendSeries.length) % visibleLegendSeries.length
      ));
      onActivate?.();
      return;
    }
    if (isPlainKey(event, "space") && legendKeyboardIndex !== null) {
      const entry = visibleLegendSeries[legendKeyboardIndex];
      if (!entry || !onToggleSeries || !(isSeriesToggleable?.(entry) ?? true)) return;
      event.preventDefault();
      event.stopPropagation();
      onActivate?.();
      onToggleSeries(entry.id);
      return;
    }
    if (isPlainKey(event, "escape") && (armedTool || selectedDrawingId)) {
      event.preventDefault();
      event.stopPropagation();
      setArmedTool(null);
      setSelectedDrawingId(null);
      return;
    }
    if (isPlainKey(event, "escape") && legendKeyboardIndex !== null && !scene?.cursorDate) {
      event.preventDefault();
      event.stopPropagation();
      setLegendKeyboardIndex(null);
      return;
    }
    const interaction = resolveCompositeChartInteraction(event);
    if (!interaction) return;
    if (
      (interaction === "clear-cursor" && !scene?.cursorDate)
      || ((interaction === "arm-measure"
        || interaction === "arm-zoom"
        || interaction === "arm-line"
        || interaction === "arm-pencil") && !scene)
      || (interaction === "delete-drawing" && drawings.length === 0)
      || (interaction === "cycle-colour" && !isDrawingTool(armedTool) && !selectedDrawingId)
      || ((interaction === "cursor-left" || interaction === "cursor-right") && !scene)
      || ((interaction === "zoom-in"
        || interaction === "zoom-out"
        || interaction === "pan-left"
        || interaction === "pan-right") && !navigationBounds)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
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
        return;
      }
      case "pan-left":
        panViewport(COMPOSITE_KEYBOARD_PAN_RATIO);
        return;
      case "pan-right":
        panViewport(-COMPOSITE_KEYBOARD_PAN_RATIO);
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
  }, { enabled: focused && interactive });

  const leftPadding = leftAxisWidth + (leftAxisWidth ? axisGap : 0);
  const rightPadding = rightAxisWidth + (rightAxisWidth ? axisGap : 0);
  const timeAxisLayout = scene && showTimeAxis
    ? buildCompositeTimeAxisLayout(scene, plotWidth)
    : null;
  const emptyTimeAxisLayout = !scene && showTimeAxis && liveViewport
    ? buildCompositeViewportTimeAxisLayout(liveViewport, plotWidth)
    : null;

  if (!scene) {
    const emptyPlotHeight = Math.max(0, totalHeight - legendRows - timeAxisRows);
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
              onMouseScroll={interactive && navigationBounds ? handleEmptyMouseScroll : undefined}
              cursor={interactive && navigationBounds ? "grab" : undefined}
              data-gloom-interactive={interactive && navigationBounds ? "true" : undefined}
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
  const timeAxisCursorLabel = scene.cursorDate
    ? formatCompositeTimeAxisDate(scene.cursorDate, scene.startTime, scene.endTime)
    : null;
  // The crosshair labels the moving end, so the axis only adds the anchor.
  const timeAxisMarkers = toolSpan
    ? [{
      ratio: toolSpan.startXRatio,
      label: formatCompositeTimeAxisDate(
        new Date(unprojectCompositeTimestamp(scene.timeScale, toolSpan.startXRatio)),
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
      {interactive && plotWidth > CHART_TOOLBAR_WIDTH + 4 ? (
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
          engine={engine}
          panel={panel}
          scene={scene}
          plotWidth={plotWidth}
          leftAxisWidth={leftAxisWidth}
          rightAxisWidth={rightAxisWidth}
          axisGap={axisGap}
          colors={resolvedColors}
          interactive={interactive}
          viewport={liveViewport!}
          minimumViewportSpanMs={minimumViewportSpanMs}
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
          showTextFallback={showTextFallback}
        />
      ))}
      {timeAxisLayout ? (
        <Box flexDirection="row" width={totalWidth} height={1}>
          {leftPadding > 0 ? <Box width={leftPadding} /> : null}
          <StaticXAxisLabels
            labels={[timeAxisLayout.text]}
            positionedLabels={timeAxisLayout.ticks}
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
    </Box>
  );
}
