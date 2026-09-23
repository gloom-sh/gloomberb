import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChartSurface, useNativeRenderer, useUiHost } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { resolveChartPalette } from "../core/palette";
import { consumeChartMouseEvent, getLocalPlotPointer, type ChartMouseEvent } from "../core/pointer";
import { useStaticChartBitmapSize } from "../composite/bitmap";
import {
  buildSurface3DScene, clampSurface3DCamera, hitTestSurface3D, rotateSurface3DCamera, zoomSurface3DCamera,
  type Surface3DCamera, type Surface3DCell, type Surface3DInput,
} from "./model";
import { renderSurface3DSoftware, type Surface3DColors } from "./software";

export interface Surface3DChartProps {
  input: Surface3DInput;
  camera: Surface3DCamera;
  onCameraChange: (camera: Surface3DCamera) => void;
  onSelect: (cell: Surface3DCell) => void;
  width: number;
  height: number;
  ariaLabel?: string;
  /** Shown when neither a GPU nor a bitmap renderer is available. */
  fallback?: ReactNode;
}

const RIDGE = "#ffd27a";

/** Desktop draws on the GPU; terminals use the software raster over the same scene. */
export function Surface3DChart(props: Surface3DChartProps) {
  const host = useUiHost();
  const themeColors = useThemeColors();
  const colors = useMemo<Surface3DColors>(() => {
    const palette = resolveChartPalette(themeColors);
    return { bg: palette.bgColor, grid: palette.gridColor, axis: palette.axisColor, accent: palette.activeRangeColor, ridge: RIDGE };
  }, [themeColors]);
  const scene = useMemo(() => buildSurface3DScene(props.input, 5), [props.input]);
  const reserveRight = props.width >= 60 ? 0.1 : 0;
  const Gpu = host.Surface3D;
  if (Gpu) {
    return <Gpu width={props.width} height={props.height} scene={scene} camera={props.camera} colors={colors} reserveRight={reserveRight}
      onCameraChange={props.onCameraChange} onSelect={props.onSelect} ariaLabel={props.ariaLabel}
      fallback={<SoftwareSurface3D {...props} scene={scene} colors={colors} reserveRight={reserveRight} />} />;
  }
  return <SoftwareSurface3D {...props} scene={scene} colors={colors} reserveRight={reserveRight} />;
}

function SoftwareSurface3D(props: Surface3DChartProps & { scene: ReturnType<typeof buildSurface3DScene>; colors: Surface3DColors; reserveRight: number }) {
  const host = useUiHost();
  const renderer = useNativeRenderer();
  const surfaceRef = useRef<Parameters<typeof getLocalPlotPointer>[1]>(null);
  // The camera moves locally while dragging and is committed on release.
  const drag = useRef<{ x: number; y: number; camera: Surface3DCamera; moved: boolean } | null>(null);
  const [liveCamera, setLiveCamera] = useState<Surface3DCamera | null>(null);
  const { cellWidthPx = 8, cellHeightPx = 18 } = host.capabilities ?? {};
  const size = useStaticChartBitmapSize(props.width, props.height);
  const camera = liveCamera ?? props.camera;
  const render = useMemo(() => size ? renderSurface3DSoftware(props.scene, size.pixelWidth, size.pixelHeight, props.colors, camera,
    { quality: liveCamera ? "draft" : "high", reserveRight: props.reserveRight }) : null,
  [size, props.scene, props.colors, camera, liveCamera != null, props.reserveRight]);
  if (!size || !render) return <>{props.fallback ?? null}</>;
  const pointer = (event: ChartMouseEvent) => getLocalPlotPointer(event, surfaceRef.current, renderer);
  const toBitmap = (at: NonNullable<ReturnType<typeof pointer>>) => ({
    x: at.hasPixelPrecision ? at.cellX / Math.max(1, props.width - 1) * (render.bitmap.width - 1) : at.cellX / Math.max(1, props.width) * render.bitmap.width,
    y: at.hasPixelPrecision ? at.cellY / Math.max(1, props.height - 1) * (render.bitmap.height - 1) : at.cellY / Math.max(1, props.height) * render.bitmap.height,
  });
  const finish = (event: ChartMouseEvent) => {
    const started = drag.current;
    drag.current = null;
    if (!started) return;
    if (started.moved) {
      if (liveCamera) props.onCameraChange(liveCamera);
      setLiveCamera(null);
      return;
    }
    const at = pointer(event);
    if (!at) return;
    const point = toBitmap(at);
    const cell = hitTestSurface3D(props.scene, render.viewport, point.x, point.y, Math.max(12, render.bitmap.width / Math.max(1, props.width) * 2));
    if (cell) props.onSelect(cell);
  };
  return <ChartSurface ref={surfaceRef} width={props.width} height={props.height} flexDirection="column"
    bitmaps={[render.bitmap]} data-gloom-role="surface-3d" aria-label={props.ariaLabel}
    onMouseDown={(event: ChartMouseEvent) => {
      const at = pointer(event);
      if (!at) return;
      consumeChartMouseEvent(event);
      drag.current = { x: at.cellX, y: at.cellY, camera: props.camera, moved: false };
    }}
    onMouseDrag={(event: ChartMouseEvent) => {
      const at = pointer(event), started = drag.current;
      if (!at || !started) return;
      consumeChartMouseEvent(event);
      const dx = at.cellX - started.x, dy = at.cellY - started.y;
      if (!started.moved && Math.hypot(dx * cellWidthPx, dy * cellHeightPx) < 4) return;
      started.moved = true;
      setLiveCamera(rotateSurface3DCamera(started.camera, -dx / Math.max(props.width, 1) * 4.2, dy / Math.max(props.height, 1) * 1.8));
    }}
    onMouseUp={finish} onMouseDragEnd={finish}
    onMouseScroll={(event: ChartMouseEvent) => {
      if (!event.scroll) return;
      consumeChartMouseEvent(event);
      const delta = event.scroll.deltaY ?? ((event.scroll.direction === "up" ? -1 : 1) * 70);
      props.onCameraChange(zoomSurface3DCamera(clampSurface3DCamera(props.camera), Math.exp(-delta * 0.0017)));
    }} />;
}
