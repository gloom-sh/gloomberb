import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChartSurface, useNativeRenderer, useUiHost } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { consumeChartMouseEvent, getLocalPlotPointer, type ChartMouseEvent } from "../../../components/chart/core/pointer";
import { useStaticChartBitmapSize } from "../../../components/chart/composite/bitmap";
import {
  hitTestSurface, renderVolatilitySurface, rotateSurfaceCamera, zoomSurfaceCamera,
  type SurfaceCamera, type SurfaceCell, type VolatilitySurfaceGrid,
} from "./raster";

export interface VolatilitySurfaceProps {
  grid: VolatilitySurfaceGrid;
  camera: SurfaceCamera;
  onCameraChange: (camera: SurfaceCamera) => void;
  selected: SurfaceCell | null;
  onSelect: (cell: SurfaceCell) => void;
  width: number;
  height: number;
  /** The pane's shared shaded table remains usable without a bitmap renderer. */
  fallback?: ReactNode;
}

export function VolatilitySurface(props: VolatilitySurfaceProps) {
  const colors = useThemeColors();
  const host = useUiHost();
  const renderer = useNativeRenderer();
  const surfaceRef = useRef<Parameters<typeof getLocalPlotPointer>[1]>(null);
  const drag = useRef<{ x: number; y: number; camera: SurfaceCamera; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const { cellWidthPx = 8, cellHeightPx = 18 } = host.capabilities ?? {};
  const size = useStaticChartBitmapSize(props.width, props.height);
  const palette = useMemo(() => resolveChartPalette(colors), [colors]);
  const scene = useMemo(() => {
    if (!size) return null;
    return renderVolatilitySurface(props.grid, size.pixelWidth, size.pixelHeight, palette, props.camera, props.selected);
  }, [size, props.grid, props.camera, props.selected, palette]);
  const pointer = (event: ChartMouseEvent) => getLocalPlotPointer(event, surfaceRef.current, renderer);
  const finishDrag = (event: ChartMouseEvent) => {
    const started = drag.current;
    drag.current = null;
    setDragging(false);
    if (!started || started.moved || !scene) return;
    const at = pointer(event);
    if (!at) return;
    const x = at.hasPixelPrecision ? at.cellX / Math.max(1, props.width - 1) * (scene.bitmap.width - 1)
      : at.cellX / Math.max(1, props.width) * scene.bitmap.width;
    const y = at.hasPixelPrecision ? at.cellY / Math.max(1, props.height - 1) * (scene.bitmap.height - 1)
      : at.cellY / Math.max(1, props.height) * scene.bitmap.height;
    const cell = hitTestSurface(scene, x, y, Math.max(12, scene.bitmap.width / Math.max(1, props.width) * 2));
    if (cell) props.onSelect(cell);
  };
  return <ChartSurface ref={surfaceRef} width={props.width} height={props.height} flexDirection="column"
    bitmaps={scene ? [scene.bitmap] : null} data-gloom-role="volatility-surface"
    aria-label="Implied volatility surface" style={{ cursor: dragging ? "grabbing" : "grab" }}
    onMouseDown={(event: ChartMouseEvent) => {
      const at = pointer(event);
      if (!at || !scene) return;
      consumeChartMouseEvent(event);
      drag.current = { x: at.cellX, y: at.cellY, camera: props.camera, moved: false };
      setDragging(true);
    }}
    onMouseDrag={(event: ChartMouseEvent) => {
      const at = pointer(event), started = drag.current;
      if (!at || !started) return;
      consumeChartMouseEvent(event);
      const dx = at.cellX - started.x, dy = at.cellY - started.y;
      if (Math.hypot(dx * cellWidthPx, dy * cellHeightPx) < 4) return;
      started.moved = true;
      props.onCameraChange(rotateSurfaceCamera(started.camera, dx / Math.max(props.width, 1) * 4.2,
        dy / Math.max(props.height, 1) * 1.8));
    }}
    onMouseUp={finishDrag} onMouseDragEnd={finishDrag}
    onMouseScroll={(event: ChartMouseEvent) => {
      if (!event.scroll || !scene) return;
      consumeChartMouseEvent(event);
      const delta = event.scroll.deltaY ?? ((event.scroll.direction === "up" ? -1 : 1) * 70);
      props.onCameraChange(zoomSurfaceCamera(props.camera, Math.exp(-delta * 0.0017)));
    }}>
    {props.fallback}
  </ChartSurface>;
}
