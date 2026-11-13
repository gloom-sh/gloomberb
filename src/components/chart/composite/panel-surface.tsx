import { useRef, useState } from "react";
import {
  Box,
  Text,
  useNativeRenderer,
  useUiCapabilities,
  type BoxRenderable,
} from "../../../ui";
import { Button } from "../../ui/button";
import { useStaticChartBitmapSize } from "./bitmap";
import { useMeasuredCells } from "../../../ui/measured-cells";
import type { ChartToolDrag } from "./tools";
import { compositeRightOffsetRatio } from "./time-scale";
import type { CompositeAxisSide } from "./types";
import { useCompositePanelBitmap } from "./panel-bitmap";
import { COMPOSITE_PANEL_ROLE } from "./panel-gestures";
import { createValueStore } from "./cursor-source";
import type { CompositePanelSurfaceProps } from "./panel-surface/props";
import { usePanelToolReadout } from "./panel-surface/tool-readout";
import { usePanelLevels } from "./panel-surface/panel-levels";
import { usePanelOverlays } from "./panel-surface/overlays";
import { usePanelAxisMarkers } from "./panel-surface/axis-markers";
import { usePlotPointer } from "./panel-surface/plot-pointer";
import { usePanCoast } from "./panel-surface/pan-coast";
import { usePlotGestures } from "./panel-surface/plot-gestures";
import { usePlotWheel } from "./panel-surface/plot-wheel";
import { useValueAxisGestures } from "./panel-surface/value-axis-gestures";
import { DESKTOP_PLOT_PICK_STYLE, DESKTOP_PLOT_STYLE, PanelPlotSurface, PanelValueAxis } from "./panel-surface/panel-cursor";
import { PanelLevelLabels } from "./panel-surface/level-labels";

/** The grab strip over the line between two panels: the line and a few pixels either side of it. */
const PANEL_DIVIDER_STYLE = {
  left: 0,
  right: 0,
  width: "auto",
  top: "calc(-1 * var(--gloom-space-xs))",
  height: "calc(2 * var(--gloom-space-xs) + 1px)",
} as const;

/** The chart's rule between two panels: the border colour, a pixel thick, over the plot and both gutters, never taking the pointer. */
const PANEL_RULE_STYLE = {
  left: 0,
  right: 0,
  width: "auto",
  height: "1px",
  background: "var(--gloom-border)",
  pointerEvents: "none",
} as const;

/**
 * One panel of a composite chart: its plot between its value axes, and what
 * draws over them. The hooks in `panel-surface/` own its parts: the tool's
 * readout, the levels, the overlays, the axis labels and tags, and the
 * pointer's gestures on the plot and on the axes.
 */
export function CompositePanelSurface({
  panel,
  scene,
  cursor,
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
  sharedCursor,
  onPanViewport,
  onZoomViewport,
  onSetViewport,
  onToolSpanChange,
  onDragActiveChange,
  keyboardToolDrag,
  onPointerPress,
  showTextFallback,
  onPickTime,
  onPickPrice,
  levels,
  selectedLevelId,
  onSelectLevel,
  valueScalable,
  onSetValueScale,
  onResetValueScale,
  ruleAbove = false,
  dividerAbove = null,
  onToggleMaximized,
}: CompositePanelSurfaceProps) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const { cellHeightPx = 18, cellWidthPx = 8, fractionalViewport = false } = useUiCapabilities();
  const renderer = useNativeRenderer();
  const plotRef = useRef<BoxRenderable | null>(null);
  // The pointer's height over the plot, 0 at the top and 1 at the bottom. It
  // moves with the pointer without rendering the panel: only what draws the
  // crosshair reads it.
  const [pointerY] = useState(() => createValueStore<number | null>(null));
  const [toolDrag, setToolDrag] = useState<ChartToolDrag | null>(null);
  // A pointer drag owns the plot while it lasts; otherwise a tool placed from
  // the keyboard draws and reads out exactly like one.
  const keyboardDrag = toolDrag ? null : keyboardToolDrag;
  const activeDrag = toolDrag ?? keyboardDrag?.drag ?? null;
  const cursorView = { panel, cursor, pointerY, keyboardDrag, sharedCursor };
  // The plot's box as the browser lays it out: on the desktop a chart that
  // fills its box has it a fraction of a cell past its columns and rows. The
  // bitmap is drawn at that size, so it is 1:1 at rest, and the pointer is
  // read back into the scene's columns and rows. Elsewhere, and in the
  // terminal, it is the plot's cells.
  const plotSize = useMeasuredCells(plotRef, { width: plotWidth, height: panel.height });
  const plotAspect = (plotSize.width * cellWidthPx) / Math.max(plotSize.height * cellHeightPx, 1);
  // The plot is wider than the viewport by the reserved right offset. Gestures
  // read the pointer in plot space, so they convert through this.
  const plotSpanFactor = 1 + compositeRightOffsetRatio(scene.timeScale);
  const bitmapSize = useStaticChartBitmapSize(plotSize.width, plotSize.height);
  const bitmap = useCompositePanelBitmap({ panel, bitmapSize, colors, isDesktopWeb, revealed: plotSize.revealed === true });
  const { toolDirection, measureReadout, anchorMarker } = usePanelToolReadout({
    panel, scene, colors, activeDrag, keyboardDrag, onToolSpanChange, plotWidth, leftAxisWidth, axisGap,
  });
  const { levelDraftRef, setLevelDraft, levelDomain, projectedLevels, levelGrab } = usePanelLevels({
    panel, levels, armedTool, onPickTime, onPickPrice,
  });
  const { bitmapLayers, vectors } = usePanelOverlays({
    bitmap, isDesktopWeb, panel, scene, colors, drawings, selectedDrawingId, drawColor, selectedLevelId,
    activeDrag, toolDirection, projectedLevels,
  });
  const {
    leftAxisLabels,
    rightAxisLabels,
    leftAxisTicks,
    rightAxisTicks,
    leftAxisMarkers,
    rightAxisMarkers,
  } = usePanelAxisMarkers({
    panel, colors, formatAxisValue, leftAxisWidth, rightAxisWidth, selectedLevelId, levelDomain, projectedLevels,
    anchorMarker, cellHeightPx, fractionalViewport,
  });
  const { plotPointer, pointerRatios, updateCursor, clearCursor } = usePlotPointer({
    plotRef, renderer, plotSize, plotWidth, panelHeight: panel.height, scene, pointerY, onCursorDateChange,
  });
  const { stopCoast, startCoast } = usePanCoast({ isDesktopWeb, plotWidth: plotSize.width, onPanViewport });
  const { pressPlot, pressCursor, dragViewport, releasePlot, handleMouseMove } = usePlotGestures({
    panel, scene, frame, viewport, armedTool, drawings, drawColor, levels, plotWidth,
    onActivate, onPointerPress, onPickTime, onPickPrice, onSelectDrawing, onEditDrawing, onDraw, onSelectLevel,
    onPanViewport, onSetViewport, onSetValueScale, onDragActiveChange, onToggleMaximized,
    isDesktopWeb, renderer, plotSize, plotAspect, plotSpanFactor, setToolDrag,
    levelDomain, projectedLevels, levelDraftRef, setLevelDraft,
    plotPointer, pointerRatios, updateCursor, stopCoast, startCoast,
  });
  const panFromWheel = usePlotWheel({
    frame, viewport, onPanViewport, onZoomViewport, onActivate, plotWidth, plotSpanFactor,
    measuredPlotWidth: plotSize.width, cellWidthPx, isDesktopWeb, stopCoast, plotPointer, updateCursor,
  });
  const { leftAxisGestures, rightAxisGestures } = useValueAxisGestures({
    plotRef, panel, valueScalable, onSetValueScale, onResetValueScale, onActivate, isDesktopWeb, cellHeightPx, fractionalViewport,
  });
  // While the panel is scaled by hand, the foot of the axis scaled says so
  // and is the way back.
  const manuallyScaled = !!panel.axes.left?.manual || !!panel.axes.right?.manual;
  const manualSide: CompositeAxisSide | null = !valueScalable || !manuallyScaled ? null
    : panel.axes.right?.manual && rightAxisWidth > 0 ? "right"
      : panel.axes.left?.manual && leftAxisWidth > 0 ? "left"
        : rightAxisWidth > 0 ? "right" : leftAxisWidth > 0 ? "left" : null;
  const manualLabel = (manualSide === "left" ? leftAxisWidth : rightAxisWidth) >= 4 ? "Auto" : "A";

  return (
    <Box
      flexDirection="row"
      height={panel.height}
      width={plotWidth + leftAxisWidth + rightAxisWidth + axisGap * ((leftAxisWidth ? 1 : 0) + (rightAxisWidth ? 1 : 0))}
      position="relative"
      // Desktop: spans the chart's box and takes its share of the height, so
      // when a resize draws the box at a new size between renders the plot
      // follows it by CSS. At rest, the size the cells give it.
      style={isDesktopWeb ? { width: "100%", flex: `${panel.height} 1 calc(${panel.height} * var(--cell-h))`, height: "auto", minHeight: 0 } : undefined}
    >
      {ruleAbove && isDesktopWeb ? (
        <Box
          position="absolute"
          left={0}
          top={0}
          height={1}
          zIndex={6}
          style={PANEL_RULE_STYLE}
          data-gloom-role="composite-chart-panel-rule"
        />
      ) : null}
      {dividerAbove && isDesktopWeb ? (
        // A line too thin to grab, so the handle straddles it, as a pane
        // sidebar's does; it draws only while the pointer is on it.
        <Box
          position="absolute"
          left={0}
          top={0}
          height={1}
          zIndex={29}
          style={PANEL_DIVIDER_STYLE}
          {...dividerAbove.gestures}
          title="Drag to resize the panels, double-click for the default split"
          data-gloom-interactive="true"
          data-gloom-role="composite-chart-panel-divider"
          data-active={dividerAbove.active ? "true" : undefined}
        />
      ) : null}
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
              paddingInline: "var(--gloom-space-xs)",
              borderRadius: "var(--gloom-radius-sm)",
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
          <PanelValueAxis
            view={cursorView}
            formatAxisValue={formatAxisValue}
            axisLabels={leftAxisLabels}
            axisTicks={leftAxisTicks}
            axisWidth={leftAxisWidth}
            axisSectionWidth={leftAxisWidth}
            side="left"
            height={panel.height}
            cursorColor={colors.crosshair}
            cursorBackgroundColor={colors.background}
            axisColor={colors.textDim}
            extraMarkers={leftAxisMarkers}
            measuredPixelHeight={plotSize.height * cellHeightPx}
            gestures={leftAxisGestures}
            footButton={manualSide === "left"}
          />
          <Box width={axisGap} />
        </>
      ) : null}
      <PanelPlotSurface
        view={cursorView}
        plotRef={plotRef}
        bitmap={bitmap}
        crosshairColor={colors.crosshair}
        textColor={colors.text}
        textFallback={!isDesktopWeb && showTextFallback}
        plotWidth={plotWidth}
        projectedLevels={projectedLevels}
        selectedLevelId={selectedLevelId}
        levelGrab={levelGrab}
        // Its measured box on the desktop, where pointer bounds read it; CSS lays it out.
        width={plotSize.width}
        height={plotSize.height}
        // Desktop: the width the axes leave, and the row's height.
        style={isDesktopWeb ? onPickPrice ? DESKTOP_PLOT_PICK_STYLE : DESKTOP_PLOT_STYLE : undefined}
        flexDirection="column"
        bitmaps={bitmapLayers}
        vectors={vectors}
        onMouseMove={interactive ? handleMouseMove : undefined}
        onMouseDown={interactive ? navigable ? pressPlot : pressCursor : undefined}
        onMouseDrag={interactive && navigable ? dragViewport : undefined}
        onMouseUp={interactive && navigable ? releasePlot : undefined}
        onMouseDragEnd={interactive && navigable ? releasePlot : undefined}
        onMouseScroll={interactive && navigable ? panFromWheel : undefined}
        onMouseOut={interactive ? clearCursor : undefined}
        cursor={interactive ? toolDrag || !navigable || onPickTime || onPickPrice ? "crosshair" : "grab" : undefined}
        data-gloom-interactive={interactive ? "true" : undefined}
        data-gloom-role={COMPOSITE_PANEL_ROLE}
        data-gloom-remote-kind={remoteKind}
        data-gloom-label={panel.label ?? panel.id}
        data-gloom-value-scale={manuallyScaled ? "manual" : undefined}
      />
      {projectedLevels.length > 0 ? (
        <PanelLevelLabels
          view={cursorView}
          projectedLevels={projectedLevels}
          levels={levels}
          levelDomain={levelDomain}
          plotWidth={plotWidth}
          leftAxisWidth={leftAxisWidth}
          rightAxisWidth={rightAxisWidth}
          axisGap={axisGap}
          leftAxisMarkers={leftAxisMarkers}
          rightAxisMarkers={rightAxisMarkers}
          measuredPixelHeight={plotSize.height * cellHeightPx}
          background={colors.background}
          isDesktopWeb={isDesktopWeb}
          cellHeightPx={cellHeightPx}
          cellWidthPx={cellWidthPx}
        />
      ) : null}
      {rightAxisWidth > 0 ? (
        <>
          <Box width={axisGap} />
          <PanelValueAxis
            view={cursorView}
            formatAxisValue={formatAxisValue}
            axisLabels={rightAxisLabels}
            axisTicks={rightAxisTicks}
            axisWidth={rightAxisWidth}
            axisSectionWidth={rightAxisWidth}
            side="right"
            height={panel.height}
            cursorColor={colors.crosshair}
            cursorBackgroundColor={colors.background}
            axisColor={colors.textDim}
            extraMarkers={rightAxisMarkers}
            measuredPixelHeight={plotSize.height * cellHeightPx}
            gestures={rightAxisGestures}
            footButton={manualSide === "right"}
          />
        </>
      ) : null}
      {manualSide ? (
        <Box
          position="absolute"
          left={manualSide === "left"
            ? 0
            : leftAxisWidth + (leftAxisWidth ? axisGap : 0) + plotWidth + axisGap + Math.max(0, rightAxisWidth - manualLabel.length)}
          top={Math.max(0, panel.height - 1)}
          width={manualLabel.length}
          height={1}
          zIndex={26}
          style={isDesktopWeb
            ? {
              left: manualSide === "left" ? 0 : "auto",
              right: manualSide === "right" ? 0 : "auto",
              top: "auto",
              bottom: "var(--gloom-space-xs)",
              width: "auto",
              height: "auto",
            }
            : undefined}
          data-gloom-role="composite-chart-value-scale"
        >
          <Button
            label="Auto Scale"
            displayLabel={manualLabel}
            title="Values scaled by hand. Fit them to the data again (or double-click the axis)."
            variant="secondary"
            compact
            stopPropagation
            onPress={() => onResetValueScale(panel.id)}
          />
        </Box>
      ) : null}
    </Box>
  );
}
