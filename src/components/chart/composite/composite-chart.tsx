import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { colors as themeColors, hoverBg } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { truncateWithEllipsis } from "../../../utils/text-wrap";
import type { ResolvedSeries } from "../../../time-series/types";
import {
  consumeChartMouseEvent,
  getGlobalMouseX,
  getLocalPlotPointer,
  type ChartMouseEvent,
} from "../core/pointer";
import type { NativeChartBitmap } from "../native/chart-rasterizer";
import {
  useStaticChartBitmapSize,
  type StaticChartBitmapSize,
} from "../static/chart/bitmap";
import { StaticXAxisLabels } from "../static/chart/axis-overlays";
import { PriceAxisLabels } from "../price-axis-labels";
import {
  formatCompositeAxisValue,
  formatCompositeCursorDate,
  formatCompositePointDetails,
  formatCompositeSeriesValue,
  formatCompositeTimeAxisDate,
} from "./format";
import {
  COMPOSITE_KEYBOARD_PAN_RATIO,
  COMPOSITE_ZOOM_STEP_FACTOR,
  clampCompositeViewport,
  panCompositeViewport,
  resolveCompositeChartInteraction,
  resolveCompositeMinimumSpanMs,
  resolveCompositeNavigationBounds,
  resolveCompositeWheelPanRatio,
  sameCompositeViewport,
  shouldResetCompositeViewport,
  zoomCompositeViewport,
  type CompositeViewportRange,
} from "./interactions";
import { buildCompositeColumnLayout, type CompositeColumnLayout } from "./column-layout";
import { renderCompositePanelBitmap } from "./rasterizer";
import {
  allocateCompositePanelHeights,
  applyCompositeChartCursor,
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
  CompositeChartColors,
  CompositeChartProps,
  CompositeChartScene,
  CompositePanelScene,
} from "./types";

// A short resize-only delay coalesces geometry churn without delaying
// live-data paints or depending on a foreground animation frame.
const DESKTOP_BITMAP_RESIZE_DEBOUNCE_MS = 32;
const LEGEND_WHEEL_DELTA_PER_CELL = 8;

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
    return renderPanelBitmap(panel, bitmapSize, colors);
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
  if (!bitmap || cursorXRatio === null || cursorYRatio === null) return null;
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
    pixelY: cursorYRatio * Math.max(bitmap.height - 1, 0),
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
  return value === null ? null : formatCompositeAxisValue(value, domain);
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
  viewport: CompositeViewportRange;
  onActivate?: () => void;
  onCursorDateChange: (date: Date | null) => void;
  onPanViewport: (shiftRatio: number, fromViewport?: CompositeViewportRange) => void;
  onZoomViewport: (zoomFactor: number, anchorRatio: number) => void;
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
  viewport,
  onActivate,
  onCursorDateChange,
  onPanViewport,
  onZoomViewport,
}: CompositePanelSurfaceProps) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const { cellHeightPx = 18 } = useUiCapabilities();
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
  const dragRef = useRef<{
    startGlobalX: number;
    startViewport: CompositeViewportRange;
  } | null>(null);
  const bitmapSize = useStaticChartBitmapSize(plotWidth, panel.height);
  const bitmap = useCompositePanelBitmap({ panel, bitmapSize, colors, isDesktopWeb });
  const columnLayout = useMemo(() => buildCompositeColumnLayout(panel), [panel]);
  const crosshair = useMemo(
    () => resolvePanelCrosshair(panel, columnLayout, bitmap, scene.cursorXRatio, activeCursorYRatio, colors.crosshair),
    [activeCursorYRatio, bitmap, colors.crosshair, columnLayout, panel, scene.cursorXRatio],
  );
  const bitmapLayers = useMemo(() => bitmap ? [bitmap] : null, [bitmap]);
  const textLines = useMemo(
    () => isDesktopWeb
      ? []
      : renderCompositePanelText(panel, plotWidth, scene.cursorXRatio, activeCursorYRatio),
    [activeCursorYRatio, isDesktopWeb, panel, plotWidth, scene.cursorXRatio],
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
    consumeChartMouseEvent(event);
    if (!updateCursor(event)) return;
    dragRef.current = {
      startGlobalX: getGlobalMouseX(event, renderer),
      startViewport: viewport,
    };
  }, [onActivate, renderer, updateCursor, viewport]);
  const dragViewport = useCallback((event: ChartMouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    consumeChartMouseEvent(event);
    updateCursor(event);
    const deltaCells = getGlobalMouseX(event, renderer) - drag.startGlobalX;
    onPanViewport(deltaCells / Math.max(plotWidth, 1), drag.startViewport);
  }, [onPanViewport, plotWidth, renderer, updateCursor]);
  const resetDrag = useCallback(() => {
    dragRef.current = null;
  }, []);
  const panFromWheel = useCallback((event: ChartMouseEvent) => {
    const direction = event.scroll?.direction;
    if (!direction) return;
    onActivate?.();
    consumeChartMouseEvent(event);
    const pointerTarget = plotRef.current as unknown as Parameters<typeof getLocalPlotPointer>[1];
    const pointer = getLocalPlotPointer(event, pointerTarget, renderer);
    if (event.modifiers.ctrl && pointer) {
      const zoomIn = direction === "up" || direction === "left";
      const magnitude = Math.min(Math.max(Math.abs(event.scroll?.delta ?? 1), 1), 8);
      const pointerRatio = pointer.cellX / Math.max(plotWidth - 1, 1);
      const anchorDate = resolveCompositeCursorDate(scene, pointer.cellX);
      const viewportSpan = Math.max(viewport.end.getTime() - viewport.start.getTime(), 1);
      const viewportAnchorRatio = anchorDate
        ? Math.max(0, Math.min(
            1,
            (anchorDate.getTime() - viewport.start.getTime()) / viewportSpan,
          ))
        : pointerRatio;
      onZoomViewport(
        zoomIn ? 1 + magnitude * 0.04 : 1 / (1 + magnitude * 0.04),
        viewportAnchorRatio,
      );
      updateCursor(event);
      return;
    }
    updateCursor(event);
    onPanViewport(resolveCompositeWheelPanRatio(direction, event.scroll?.delta));
  }, [onActivate, onPanViewport, onZoomViewport, plotWidth, renderer, updateCursor]);

  return (
    <Box flexDirection="row" height={panel.height} width={plotWidth + leftAxisWidth + rightAxisWidth + axisGap * ((leftAxisWidth ? 1 : 0) + (rightAxisWidth ? 1 : 0))}>
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
        onMouseMove={interactive ? updateCursor : undefined}
        onMouseDown={interactive ? startDrag : undefined}
        onMouseDrag={interactive ? dragViewport : undefined}
        onMouseUp={interactive ? resetDrag : undefined}
        onMouseDragEnd={interactive ? resetDrag : undefined}
        onMouseScroll={interactive ? panFromWheel : undefined}
        onMouseOut={interactive ? clearCursor : undefined}
        cursor={interactive ? "grab" : undefined}
        data-gloom-interactive={interactive ? "true" : undefined}
        data-gloom-role="composite-chart-panel"
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
  onActivate: CompositeChartProps["onActivate"];
  onToggleSeries: CompositeChartProps["onToggleSeries"];
  isSeriesToggleable: CompositeChartProps["isSeriesToggleable"];
  keyboardIndex?: number | null;
}) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const dateLabel = scene
    ? scene.cursorDate
      ? formatCompositeCursorDate(scene.cursorDate, scene.startTime, scene.endTime)
      : "Latest"
    : "";
  const cursorValueById = new Map(
    scene?.cursorValues.map((entry) => [entry.seriesId, entry] as const) ?? [],
  );
  const entries = series.map((entry) => {
    const toggleable = !!onToggleSeries && (isSeriesToggleable?.(entry) ?? true);
    const cursorValue = cursorValueById.get(entry.id);
    const fullText = `${entry.label} ${legendValue(
      entry,
      cursorValue?.value ?? null,
      formatValue,
    )}`;
    const details = formatCompositePointDetails(cursorValue?.point);
    const tooltip = details ? `${fullText} · ${details}` : fullText;
    const textWidth = Math.max(1, Math.min(30, [...fullText].length));
    return {
      entry,
      text: truncateWithEllipsis(fullText, textWidth),
      width: textWidth + 2 + (toggleable ? 5 : 0),
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
  const widthBeforeAccessory = Math.max(0, width - resolvedAccessoryWidth - reservedAccessoryGap);
  const minimumSeriesPreviewWidth = entries.length > 0
    ? Math.min(7, desiredSeriesWidth)
    : 0;
  const showDate = dateLabel.length > 0 && widthBeforeAccessory >= (
    dateLabel.length
    + (minimumSeriesPreviewWidth > 0 ? minimumSeriesPreviewWidth + 1 : 0)
  );
  const dateWidth = showDate ? dateLabel.length : 0;
  const dateSeriesGap = showDate && entries.length > 0 ? 1 : 0;
  const seriesWidth = Math.min(
    desiredSeriesWidth,
    Math.max(0, widthBeforeAccessory - dateWidth - dateSeriesGap),
  );
  const accessorySpacerWidth = accessory
    ? Math.max(
      reservedAccessoryGap,
      width - dateWidth - dateSeriesGap - seriesWidth - resolvedAccessoryWidth,
    )
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
      {showDate ? (
        <Box width={dateWidth} height={1} flexShrink={0} overflow="hidden">
          <Text fg={themeColors.textDim}>{dateLabel}</Text>
        </Box>
      ) : null}
      {dateSeriesGap > 0 ? <Box width={dateSeriesGap} flexShrink={0} /> : null}
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
                <Text fg={entryVisible ? themeColors.text : themeColors.textDim}>{text}</Text>
                {toggleable ? (
                  <Text fg={themeColors.textMuted}>
                    {entryVisible ? " Hide" : " Show"}
                  </Text>
                ) : null}
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

export function CompositeChart({
  series,
  legendSeries,
  panels,
  width,
  height,
  focused = false,
  cursorDate,
  viewport,
  viewportResetKey,
  colors,
  interactive = true,
  axisWidth = 9,
  showLegend = true,
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
  const { cellWidthPx = 8 } = useUiCapabilities();
  const [internalCursorDate, setInternalCursorDate] = useState<Date | null>(null);
  const [legendKeyboardIndex, setLegendKeyboardIndex] = useState<number | null>(null);
  const resolvedCursorDate = cursorDate === undefined ? internalCursorDate : cursorDate;
  const totalWidth = Math.max(1, Math.floor(width));
  const totalHeight = Math.max(1, Math.floor(height));
  const visibleSeries = useMemo(() => series.filter((entry) => entry.points.length > 0), [series]);
  const visibleLegendSeries = useMemo(
    () => (legendSeries ?? visibleSeries).filter((entry) => entry.points.length > 0),
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
  const navigationBounds = useMemo(
    () => resolveCompositeNavigationBounds(visibleSeries, viewport),
    [viewport, visibleSeries],
  );
  const initialViewport = useMemo(() => (
    navigationBounds
      ? viewport
        ? clampCompositeViewport(viewport, navigationBounds)
        : navigationBounds
      : null
  ), [navigationBounds, viewport]);
  const viewportSeriesKey = visibleLegendSeries
    .map((entry) => `${entry.id}:${entry.label}`)
    .join("|");
  const previousAuthoredViewportRef = useRef<CompositeViewportRange | null>(viewport ?? null);
  const previousViewportResetKeyRef = useRef(viewportResetKey);
  const [interactionViewport, setInteractionViewport] = useState<CompositeViewportRange | null>(null);
  const hasViewportResetKey = viewportResetKey !== undefined
    || previousViewportResetKeyRef.current !== undefined;
  const authoredViewportChanged = hasViewportResetKey
    ? previousViewportResetKeyRef.current !== viewportResetKey
    : shouldResetCompositeViewport(
        previousAuthoredViewportRef.current,
        viewport ?? null,
      );
  const currentInteractionViewport = authoredViewportChanged
    ? null
    : interactionViewport && navigationBounds
      ? clampCompositeViewport(interactionViewport, navigationBounds)
      : interactionViewport;
  const effectiveViewport = navigationBounds
    ? currentInteractionViewport
      ? clampCompositeViewport(currentInteractionViewport, navigationBounds)
      : initialViewport
    : null;
  const interactionViewportStart = currentInteractionViewport?.start.getTime() ?? null;
  const interactionViewportEnd = currentInteractionViewport?.end.getTime() ?? null;
  const lastReportedViewportRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onViewportChange) return;
    const interactionKey = interactionViewportStart === null || interactionViewportEnd === null
      ? "none"
      : `${interactionViewportStart}:${interactionViewportEnd}`;
    const key = `${viewportSeriesKey}|${interactionKey}`;
    // The callback drives adaptive data loading. Seed it from the authored
    // viewport without echoing that controlled value back into the loader.
    if (lastReportedViewportRef.current === null) {
      lastReportedViewportRef.current = key;
      return;
    }
    if (lastReportedViewportRef.current === key) return;
    lastReportedViewportRef.current = key;
    onViewportChange(
      interactionViewportStart === null || interactionViewportEnd === null
        ? null
        : {
            start: new Date(interactionViewportStart),
            end: new Date(interactionViewportEnd),
          },
    );
  }, [interactionViewportEnd, interactionViewportStart, onViewportChange, viewportSeriesKey]);
  const minimumViewportSpanMs = useMemo(
    () => navigationBounds ? resolveCompositeMinimumSpanMs(visibleSeries, navigationBounds) : 1,
    [navigationBounds, visibleSeries],
  );

  useEffect(() => {
    previousAuthoredViewportRef.current = viewport ?? null;
    previousViewportResetKeyRef.current = viewportResetKey;
    if (
      authoredViewportChanged
      || (interactionViewport && !navigationBounds)
    ) {
      setInteractionViewport(null);
      return;
    }
    if (interactionViewport && navigationBounds) {
      const clamped = clampCompositeViewport(interactionViewport, navigationBounds);
      if (!sameCompositeViewport(clamped, interactionViewport)) {
        setInteractionViewport(clamped);
      }
    }
  }, [
    authoredViewportChanged,
    interactionViewport,
    navigationBounds,
    viewport,
    viewportResetKey,
  ]);

  const zoomViewport = useCallback((zoomFactor: number, anchorRatio = 1) => {
    if (!navigationBounds || !initialViewport) return;
    setInteractionViewport((current) => {
      const base = current ?? initialViewport;
      const next = zoomCompositeViewport(
        base,
        navigationBounds,
        zoomFactor,
        anchorRatio,
        minimumViewportSpanMs,
        visibleSeries,
      );
      if (sameCompositeViewport(next, base)) return current;
      return current === null && sameCompositeViewport(next, initialViewport) ? null : next;
    });
  }, [initialViewport, minimumViewportSpanMs, navigationBounds, visibleSeries]);
  const panViewport = useCallback((
    shiftRatio: number,
    fromViewport?: CompositeViewportRange,
  ) => {
    if (!navigationBounds || !initialViewport) return;
    setInteractionViewport((current) => {
      const base = fromViewport ?? current ?? initialViewport;
      const next = panCompositeViewport(base, navigationBounds, shiftRatio, visibleSeries);
      if (sameCompositeViewport(next, base)) return current;
      return current === null && sameCompositeViewport(next, initialViewport) ? null : next;
    });
  }, [initialViewport, navigationBounds, visibleSeries]);
  const resetViewport = useCallback(() => {
    setInteractionViewport(null);
  }, []);
  const hasLeftAxis = visibleSeries.some((entry) => entry.axis === "left");
  const hasRightAxis = visibleSeries.some((entry) => entry.axis === "right");
  const resolvedAxisWidth = Math.max(0, Math.floor(axisWidth));
  const leftAxisWidth = hasLeftAxis ? resolvedAxisWidth : 0;
  const rightAxisWidth = hasRightAxis ? resolvedAxisWidth : 0;
  const axisGap = resolvedAxisWidth > 0 ? 1 : 0;
  const horizontalReserved = leftAxisWidth + rightAxisWidth
    + axisGap * ((leftAxisWidth ? 1 : 0) + (rightAxisWidth ? 1 : 0));
  const plotWidth = Math.max(1, totalWidth - horizontalReserved);
  const legendRows = showLegend && (visibleSeries.length > 0 || legendAccessory)
    ? 1
    : 0;
  const timeAxisRows = showTimeAxis ? 1 : 0;
  const panelCount = new Set(visibleSeries.map((entry) => entry.panelId)).size;
  const plotHeight = Math.max(panelCount, totalHeight - legendRows - timeAxisRows);
  const resolvedColors = useMemo<CompositeChartColors>(() => ({
    background: colors?.background ?? themeColors.bg,
    grid: colors?.grid ?? themeColors.border,
    crosshair: colors?.crosshair ?? themeColors.borderFocused,
    text: colors?.text ?? themeColors.text,
    textDim: colors?.textDim ?? themeColors.textDim,
    negative: colors?.negative ?? themeColors.negative,
  }), [colors]);
  const projectedScene = useMemo(() => buildCompositeChartScene(visibleSeries, panels, {
    width: 1,
    height: Math.max(panelCount, 1),
    viewport: effectiveViewport ?? undefined,
    timelineSeries: visibleLegendSeries,
  }), [effectiveViewport, panelCount, panels, visibleLegendSeries, visibleSeries]);
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
    return projectedScene.panels.map((panel) => {
      const height = panelHeights.get(panel.id) ?? 1;
      return panel.height === height ? panel : { ...panel, height };
    });
  }, [panels, plotHeight, projectedScene]);
  const baseScene = useMemo<CompositeChartScene | null>(() => {
    if (!projectedScene || !layoutPanels) return null;
    return {
      ...projectedScene,
      width: plotWidth,
      height: layoutPanels.reduce((sum, panel) => sum + panel.height, 0),
      panels: layoutPanels,
    };
  }, [layoutPanels, plotWidth, projectedScene]);
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
    const direction = event.scroll?.direction;
    if (!interactive || !navigationBounds || !direction) return;
    onActivate?.();
    consumeChartMouseEvent(event);
    if (event.modifiers.ctrl) {
      const zoomIn = direction === "up" || direction === "left";
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
  const emptyTimeAxisLayout = !scene && showTimeAxis && effectiveViewport
    ? buildCompositeViewportTimeAxisLayout(effectiveViewport, plotWidth)
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
  return (
    <Box flexDirection="column" width={totalWidth} height={totalHeight} overflow="hidden" data-gloom-role="composite-chart">
      {showLegend ? (
        <CompositeLegend
          scene={scene}
          series={visibleLegendSeries}
          visibleSeriesIds={visibleSeriesIds}
          width={totalWidth}
          accessory={legendAccessory}
          accessoryWidth={legendAccessoryWidth}
          formatValue={formatValue}
          onActivate={onActivate}
          onToggleSeries={onToggleSeries}
          isSeriesToggleable={isSeriesToggleable}
          keyboardIndex={legendKeyboardIndex}
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
          viewport={effectiveViewport!}
          onActivate={onActivate}
          onCursorDateChange={updateCursor}
          onPanViewport={panViewport}
          onZoomViewport={zoomViewport}
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
          />
          {rightPadding > 0 ? <Box width={rightPadding} /> : null}
        </Box>
      ) : null}
    </Box>
  );
}
