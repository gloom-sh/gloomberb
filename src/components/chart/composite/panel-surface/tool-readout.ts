import { useEffect, useMemo } from "react";
import { colors as themeColors } from "../../../../theme/colors";
import { formatCompositeCursorValue } from "../format";
import { unprojectCompositeValue } from "../scene";
import { unprojectCompositeTimestamp } from "../time-scale";
import {
  countMeasureBars,
  resolveMeasureAxisDomain,
  resolveMeasureDirection,
  summarizeMeasure,
  summarizeZoomRange,
  summarizeZoomSelection,
  type ChartToolDrag,
} from "../tools";
import type { KeyboardToolDrag } from "../use-composite-chart-keyboard";
import type { CompositePanelSurfaceProps } from "./props";

/** Where a measure started, marked on the value axes. */
export interface ToolAnchorMarker {
  side: null;
  yRatio: number;
  label: string;
  color: string;
}

/**
 * What a tool in hand reads out while it drags, or while it is placed from
 * the keyboard: the summary over the plot, the span it covers (told to the
 * chart, which marks it on the time axis), and the value it started from.
 */
export function usePanelToolReadout({
  panel,
  scene,
  colors,
  activeDrag,
  keyboardDrag,
  onToolSpanChange,
  plotWidth,
  leftAxisWidth,
  axisGap,
}: Pick<CompositePanelSurfaceProps, "panel" | "scene" | "colors" | "onToolSpanChange" | "plotWidth" | "leftAxisWidth" | "axisGap"> & {
  activeDrag: ChartToolDrag | null;
  keyboardDrag: KeyboardToolDrag | null;
}) {
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
  const anchorMarker = useMemo((): ToolAnchorMarker | null => {
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
  return { toolDirection: toolReadout?.direction, measureReadout, anchorMarker };
}
