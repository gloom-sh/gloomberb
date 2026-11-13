import { useCallback, type RefObject } from "react";
import type { BoxRenderable, useNativeRenderer } from "../../../../ui";
import type { MeasuredCellSize } from "../../../../ui/measured-cells";
import { consumeChartMouseEvent, getLocalPlotPointer, type ChartMouseEvent } from "../../core/pointer";
import type { ValueStore } from "../cursor-source";
import { resolveCompositeCursorDate } from "../scene";
import type { CompositePanelSurfaceProps } from "./props";

/**
 * The pointer over the plot, read back into the scene's columns and rows, and
 * the crosshair it moves: the date goes to the chart, the height stays here.
 */
export function usePlotPointer({
  plotRef,
  renderer,
  plotSize,
  plotWidth,
  panelHeight,
  scene,
  pointerY,
  onCursorDateChange,
}: Pick<CompositePanelSurfaceProps, "plotWidth" | "scene" | "onCursorDateChange"> & {
  plotRef: RefObject<BoxRenderable | null>;
  renderer: ReturnType<typeof useNativeRenderer>;
  plotSize: MeasuredCellSize;
  panelHeight: number;
  pointerY: ValueStore<number | null>;
}) {
  /** Where the pointer is over the plot, in the scene's columns and rows. */
  const plotPointer = useCallback((event: ChartMouseEvent) => {
    const pointer = getLocalPlotPointer(event, plotRef.current as unknown as Parameters<typeof getLocalPlotPointer>[1], renderer);
    if (!pointer || (plotSize.width === plotWidth && plotSize.height === panelHeight)) return pointer;
    return {
      ...pointer,
      cellX: plotSize.width > 0 ? pointer.cellX * (plotWidth / plotSize.width) : pointer.cellX,
      cellY: plotSize.height > 0 ? pointer.cellY * (panelHeight / plotSize.height) : pointer.cellY,
    };
  }, [panelHeight, plotSize.height, plotSize.width, plotWidth, renderer]);
  const pointerRatios = useCallback((event: ChartMouseEvent) => {
    const pointer = plotPointer(event);
    if (!pointer) return null;
    return {
      xRatio: plotWidth <= 1 ? 0 : Math.max(0, Math.min(1, pointer.cellX / (plotWidth - 1))),
      yRatio: panelHeight <= 1 ? 0.5 : Math.max(0, Math.min(1, pointer.cellY / (panelHeight - 1))),
    };
  }, [panelHeight, plotPointer, plotWidth]);
  const updateCursor = useCallback((event: ChartMouseEvent): boolean => {
    const pointer = plotPointer(event);
    if (!pointer) return false;
    const nextDate = resolveCompositeCursorDate(scene, pointer.cellX);
    if (!nextDate) return false;
    const nextYRatio = panelHeight <= 1
      ? 0.5
      : Math.max(0, Math.min(1, pointer.cellY / (panelHeight - 1)));
    pointerY.set(nextYRatio);
    onCursorDateChange(nextDate);
    consumeChartMouseEvent(event);
    return true;
  }, [onCursorDateChange, panelHeight, plotPointer, pointerY, scene]);
  const clearCursor = useCallback(() => {
    pointerY.set(null);
    onCursorDateChange(null);
  }, [onCursorDateChange, pointerY]);
  return { plotPointer, pointerRatios, updateCursor, clearCursor };
}
