import { useMemo } from "react";
import type { ChartSurfaceProps } from "../../../../ui";
import { colors as themeColors } from "../../../../theme/colors";
import { levelVectors, paintLevels, type ProjectedLevel } from "../levels";
import type { useCompositePanelBitmap } from "../panel-bitmap";
import { buildChartToolVectors, drawChartToolOverlay, type ChartToolDrag } from "../tools";
import type { CompositePanelSurfaceProps } from "./props";

/**
 * What draws over the plot's raster: the panel's drawings, the tool in hand
 * and the levels. The terminal paints them into the raster's layers; the
 * desktop and the web draw them as vectors over it.
 */
export function usePanelOverlays({
  bitmap,
  isDesktopWeb,
  panel,
  scene,
  colors,
  drawings,
  selectedDrawingId,
  drawColor,
  selectedLevelId,
  activeDrag,
  toolDirection,
  projectedLevels,
}: Pick<CompositePanelSurfaceProps, "panel" | "scene" | "colors" | "drawings" | "selectedDrawingId" | "drawColor" | "selectedLevelId"> & {
  bitmap: ReturnType<typeof useCompositePanelBitmap>;
  isDesktopWeb: boolean;
  activeDrag: ChartToolDrag | null;
  toolDirection: "up" | "down" | undefined;
  projectedLevels: readonly ProjectedLevel[];
}) {
  const panelDrawings = useMemo(
    () => drawings.filter((drawing) => drawing.panelId === panel.id),
    [drawings, panel.id],
  );
  // Drawings project through the time scale alone: the crosshair moving,
  // here or on a linked chart, must not repaint the plot, which the terminal's
  // kitty surface would upload whole again.
  const drawingProjection = useMemo(() => ({ timeScale: scene.timeScale }), [scene.timeScale]);
  const bitmapLayers = useMemo(() => {
    if (!bitmap) return null;
    // The desktop composites overlays as vectors, so the plot raster stays put
    // while a tool drags. Copying and reblending it per frame is what made the
    // ruler feel heavy.
    if (isDesktopWeb) return [bitmap];
    const base = !activeDrag && panelDrawings.length === 0 ? bitmap : drawChartToolOverlay(
      bitmap,
      activeDrag,
      {
        positive: themeColors.positive,
        negative: colors.negative,
        zoom: colors.crosshair,
        draw: drawColor,
      },
      toolDirection ?? "up",
      { scene: drawingProjection, panel, items: panelDrawings, selectedId: selectedDrawingId },
    );
    return [projectedLevels.length > 0 ? paintLevels(base, projectedLevels, selectedLevelId) : base];
  }, [
    activeDrag,
    bitmap,
    colors.crosshair,
    colors.negative,
    drawColor,
    drawingProjection,
    isDesktopWeb,
    panel,
    panelDrawings,
    projectedLevels,
    selectedDrawingId,
    selectedLevelId,
    toolDirection,
  ]);
  const vectors = useMemo<ChartSurfaceProps["vectors"]>(() => {
    if (!isDesktopWeb) return null;
    const shapes = [...levelVectors(projectedLevels, selectedLevelId), ...buildChartToolVectors({
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
      direction: toolDirection ?? "up",
    })];
    return shapes.length > 0 ? shapes : null;
  }, [
    activeDrag,
    colors.crosshair,
    colors.negative,
    drawColor,
    isDesktopWeb,
    panel,
    panelDrawings,
    projectedLevels,
    scene,
    selectedDrawingId,
    selectedLevelId,
    toolDirection,
  ]);
  return { bitmapLayers, vectors };
}
