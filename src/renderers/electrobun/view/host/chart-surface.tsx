/** @jsxImportSource react */
import {
  forwardRef,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import type { ChartPaintSource, ChartPointerInput } from "../../../../components/chart/core/painter";
import type {
  BitmapSurface,
  BoxRenderable,
  ChartCrosshairOverlay,
  ChartVectorShape,
} from "../../../../ui/host";
import { WebBox } from "./box";
import { CanvasChartPainter } from "./chart-painter";
import { cancelWebFrame, requestWebFrame } from "./mouse";

const PAN_SCENE_INTERVAL_MS = 50;
const PAN_CROSSHAIR_X = "--gloom-chart-pan-x";
const PAN_CROSSHAIR_Y = "--gloom-chart-pan-y";

const CanvasBitmap = memo(function CanvasBitmap({ bitmap }: { bitmap: BitmapSurface }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const pixels = bitmap.pixels.buffer instanceof ArrayBuffer
      ? new Uint8ClampedArray(bitmap.pixels.buffer, bitmap.pixels.byteOffset, bitmap.pixels.byteLength)
      : new Uint8ClampedArray(bitmap.pixels);
    context.putImageData(new ImageData(pixels, bitmap.width, bitmap.height), 0, 0);
  }, [bitmap]);

  return (
    <canvas
      ref={canvasRef}
      width={bitmap.width}
      height={bitmap.height}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
      }}
    />
  );
});

const PaintedChart = memo(function PaintedChart({ source }: { source: ChartPaintSource }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  const lastMouseXRef = useRef<number | null>(null);
  const scrollEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollAxisRef = useRef<"x" | "y" | null>(null);
  const panFrameRef = useRef<number | null>(null);
  const latestPanInputRef = useRef<ChartPointerInput | null>(null);
  const lastPanFrameTimeRef = useRef(Number.NEGATIVE_INFINITY);
  const crosshairClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (crosshairClearTimerRef.current !== null) clearTimeout(crosshairClearTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    let paintedRevision = Number.NaN;
    const paint = () => {
      const canvas = canvasRef.current;
      const frame = source.getFrame();
      if (!canvas || !frame) return;
      canvas.style.width = `${frame.width}px`;
      canvas.style.transform = `translate3d(${frame.offsetX}px, 0, 0)`;
      if (paintedRevision === frame.revision) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(frame.width * ratio));
      const height = Math.max(1, Math.round(frame.height * ratio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      frame.paint(new CanvasChartPainter(context, frame.width, frame.height));
      paintedRevision = frame.revision;
    };
    paint();
    return source.subscribe(paint);
  }, [source]);

  const mouseInput = (event: Pick<globalThis.MouseEvent, "clientX" | "clientY" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">): ChartPointerInput => {
    const surface = canvasRef.current?.parentElement ?? canvasRef.current;
    const bounds = surface?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey || event.metaKey,
    };
  };

  const setTransientCrosshair = (input: ChartPointerInput) => {
    if (crosshairClearTimerRef.current !== null) clearTimeout(crosshairClearTimerRef.current);
    crosshairClearTimerRef.current = null;
    const surface = canvasRef.current?.parentElement;
    if (!surface) return;
    const viewport = source.getViewportSize();
    surface.style.setProperty(
      PAN_CROSSHAIR_X,
      `${Math.max(0, Math.min(viewport.width - 1, input.x))}px`,
    );
    surface.style.setProperty(
      PAN_CROSSHAIR_Y,
      `${Math.max(0, Math.min(viewport.height - 1, input.y))}px`,
    );
  };
  const clearTransientCrosshair = () => {
    const surface = canvasRef.current?.parentElement;
    surface?.style.removeProperty(PAN_CROSSHAIR_X);
    surface?.style.removeProperty(PAN_CROSSHAIR_Y);
  };
  const scheduleCrosshairClear = () => {
    if (crosshairClearTimerRef.current !== null) clearTimeout(crosshairClearTimerRef.current);
    crosshairClearTimerRef.current = setTimeout(() => {
      crosshairClearTimerRef.current = null;
      clearTransientCrosshair();
    }, 100);
  };
  const flushPanFrame = () => {
    if (panFrameRef.current !== null) cancelWebFrame(panFrameRef.current);
    panFrameRef.current = null;
    const input = latestPanInputRef.current;
    latestPanInputRef.current = null;
    if (input) source.panFrame?.(input);
  };
  const schedulePanFrame = (input: ChartPointerInput) => {
    latestPanInputRef.current = input;
    if (!source.panFrame || panFrameRef.current !== null) return;
    const update = (timestamp: number) => {
      if (timestamp - lastPanFrameTimeRef.current < PAN_SCENE_INTERVAL_MS) {
        panFrameRef.current = requestWebFrame(update);
        return;
      }
      panFrameRef.current = null;
      lastPanFrameTimeRef.current = timestamp;
      const latest = latestPanInputRef.current;
      latestPanInputRef.current = null;
      if (latest) source.panFrame?.(latest);
    };
    panFrameRef.current = requestWebFrame(update);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source.scrollPan) return;
    const finish = () => {
      if (scrollEndTimerRef.current !== null) clearTimeout(scrollEndTimerRef.current);
      scrollEndTimerRef.current = null;
      scrollAxisRef.current = null;
      flushPanFrame();
      source.scrollPanEnd?.();
      scheduleCrosshairClear();
    };
    const wheel = (event: globalThis.WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.deltaMode !== 0) return;
      const axis = scrollAxisRef.current
        ?? (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? "x" : "y");
      const delta = axis === "x" ? event.deltaX : event.deltaY;
      if (delta === 0 || !source.scrollPan?.(delta)) return;
      const input = mouseInput(event);
      setTransientCrosshair(input);
      schedulePanFrame(input);
      scrollAxisRef.current = axis;
      if (scrollEndTimerRef.current !== null) clearTimeout(scrollEndTimerRef.current);
      scrollEndTimerRef.current = setTimeout(finish, 120);
      event.preventDefault();
      event.stopPropagation();
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", wheel);
      finish();
    };
  }, [source]);

  useEffect(() => {
    const move = (event: globalThis.MouseEvent) => {
      if (!draggingRef.current) return;
      const input = mouseInput(event);
      source.pointerMove?.(input);
      setTransientCrosshair(input);
      schedulePanFrame(input);
      lastMouseXRef.current = event.clientX;
      event.preventDefault();
      event.stopPropagation();
    };
    const finish = (event: globalThis.MouseEvent) => {
      if (!draggingRef.current || event.button !== 0) return;
      draggingRef.current = false;
      const input = mouseInput(event);
      if (lastMouseXRef.current !== event.clientX) source.pointerMove?.(input);
      latestPanInputRef.current = input;
      flushPanFrame();
      source.pointerUp?.(input);
      scheduleCrosshairClear();
      lastMouseXRef.current = null;
      event.preventDefault();
      event.stopPropagation();
    };
    const cancel = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      lastMouseXRef.current = null;
      if (panFrameRef.current !== null) cancelWebFrame(panFrameRef.current);
      panFrameRef.current = null;
      latestPanInputRef.current = null;
      source.pointerCancel?.();
      clearTransientCrosshair();
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", finish, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", finish, true);
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [source]);

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={(event) => {
        if (event.button !== 0 || !source.pointerDown?.(mouseInput(event.nativeEvent))) return;
        draggingRef.current = true;
        lastMouseXRef.current = event.clientX;
        setTransientCrosshair(mouseInput(event.nativeEvent));
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur();
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        position: "absolute",
        left: 0,
        top: 0,
        willChange: "transform",
      }}
    />
  );
});

const BoxLayer = memo(function BoxLayer({ bitmap, index }: { bitmap: BitmapSurface; index: number }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: index,
      }}
    >
      <CanvasBitmap bitmap={bitmap} />
    </div>
  );
});

const ChartVectors = memo(function ChartVectors({ vectors }: { vectors: readonly ChartVectorShape[] }) {
  if (vectors.length === 0) return null;
  return (
    <>
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        // An SVG is a replaced element: without an explicit size it falls back
        // to its intrinsic box and squeezes the whole overlay into a corner.
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: 9,
        }}
      >
        {vectors.map((shape) => {
          const strokeWidth = shape.strokeWidth ?? 1.4;
          const [first, second] = shape.points;
          if (shape.box && first && second) {
            return (
              <rect
                key={shape.id}
                x={Math.min(first.x, second.x)}
                y={Math.min(first.y, second.y)}
                width={Math.abs(second.x - first.x)}
                height={Math.abs(second.y - first.y)}
                fill={shape.color}
                fillOpacity={shape.fillOpacity ?? 0.18}
                stroke={shape.color}
                strokeWidth={strokeWidth}
                vectorEffect="non-scaling-stroke"
              />
            );
          }
          return (
            <polyline
              key={shape.id}
              points={shape.points.map((point) => `${point.x},${point.y}`).join(" ")}
              fill="none"
              stroke={shape.color}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      {/* Ratio space is anisotropic, so handles are placed instead of scaled. */}
      {vectors.flatMap((shape) => shape.handles
        ? shape.points.map((point, index) => (
          <div
            key={`${shape.id}:${index}`}
            style={{
              position: "absolute",
              left: `${point.x * 100}%`,
              top: `${point.y * 100}%`,
              width: 9,
              height: 9,
              borderRadius: 999,
              border: `2px solid ${shape.color}`,
              backgroundColor: "var(--gloom-bg)",
              boxSizing: "border-box",
              transform: "translate(-50%, -50%)",
              pointerEvents: "none",
              zIndex: 10,
            }}
          />
        ))
        : [])}
    </>
  );
});

function ChartCrosshair({
  surface,
  crosshair,
}: {
  surface: { width: number; height: number } | null;
  crosshair: ChartCrosshairOverlay | null;
}) {
  if (!surface || !crosshair) return null;
  const x = surface.width <= 1 ? 0 : (crosshair.pixelX / (surface.width - 1)) * 100;
  const y = surface.height <= 1 ? 0 : (crosshair.pixelY / (surface.height - 1)) * 100;
  const clampedX = Math.max(0, Math.min(100, x));
  const clampedY = Math.max(0, Math.min(100, y));
  return (
    <>
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `var(${PAN_CROSSHAIR_X}, ${clampedX}%)`,
          width: 1,
          backgroundColor: crosshair.color,
          opacity: 0.78,
          transform: "translateX(-0.5px)",
          pointerEvents: "none",
          zIndex: 10,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `var(${PAN_CROSSHAIR_Y}, ${clampedY}%)`,
          height: 1,
          backgroundColor: crosshair.color,
          opacity: 0.78,
          transform: "translateY(-0.5px)",
          pointerEvents: "none",
          zIndex: 10,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: `var(${PAN_CROSSHAIR_X}, ${clampedX}%)`,
          top: `var(${PAN_CROSSHAIR_Y}, ${clampedY}%)`,
          width: 7,
          height: 7,
          borderRadius: 7,
          border: `1px solid ${crosshair.color}`,
          backgroundColor: `color-mix(in srgb, ${crosshair.color} 16%, transparent)`,
          boxSizing: "border-box",
          transform: "translate(-50%, -50%)",
          pointerEvents: "none",
          zIndex: 11,
        }}
      />
    </>
  );
}

export const WebChartSurface = forwardRef<BoxRenderable, Record<string, unknown> & { children?: ReactNode }>(
  function WebChartSurface({ children, ...props }, ref) {
    const bitmap = (props.bitmap ?? null) as BitmapSurface | null;
    const bitmaps = (props.bitmaps ?? null) as readonly BitmapSurface[] | null;
    const paintSource = (props.paintSource ?? null) as ChartPaintSource | null;
    const layers = bitmaps ?? (bitmap ? [bitmap] : []);
    const crosshair = (props.crosshair ?? null) as ChartCrosshairOverlay | null;
    const vectors = (props.vectors ?? null) as readonly ChartVectorShape[] | null;
    const surface = paintSource?.getViewportSize() ?? layers[0] ?? null;
    return (
      <WebBox
        {...props}
        ref={ref as Ref<HTMLDivElement>}
        data-gloom-role={(props["data-gloom-role"] as string | undefined) ?? "chart-surface"}
        style={{
          position: "relative",
          overflow: "hidden",
          touchAction: "none",
          overscrollBehavior: "none",
          ...(props.style as CSSProperties | undefined),
        }}
      >
        {paintSource
          ? <PaintedChart source={paintSource} />
          : layers.length > 0
            ? layers.map((layer, index) => (
              <BoxLayer key={`layer:${index}`} index={index} bitmap={layer} />
            ))
            : children as ReactNode}
        <ChartVectors vectors={vectors ?? []} />
        <ChartCrosshair surface={surface} crosshair={crosshair} />
      </WebBox>
    );
  },
);
