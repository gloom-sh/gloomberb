/** @jsxImportSource react */
import {
  forwardRef,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent,
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
  const pointerIdRef = useRef<number | null>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<ChartPointerInput | null>(null);

  useLayoutEffect(() => {
    const paint = () => {
      const canvas = canvasRef.current;
      const frame = source.getFrame();
      if (!canvas || !frame) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(frame.width * ratio));
      const height = Math.max(1, Math.round(frame.height * ratio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      frame.paint(new CanvasChartPainter(context, frame.width, frame.height));
    };
    paint();
    return source.subscribe(paint);
  }, [source]);

  useEffect(() => () => {
    if (pointerFrameRef.current !== null) cancelWebFrame(pointerFrameRef.current);
  }, []);

  const pointerInput = (event: PointerEvent<HTMLCanvasElement>): ChartPointerInput => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey || event.metaKey,
    };
  };
  const flushPointerMove = (input: ChartPointerInput) => {
    pendingPointerRef.current = null;
    source.pointerMove?.(input);
  };
  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !source.pointerDown?.(pointerInput(event))) return;
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur();
    event.preventDefault();
    event.stopPropagation();
  };
  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    pendingPointerRef.current = pointerInput(event);
    if (pointerFrameRef.current === null) {
      pointerFrameRef.current = requestWebFrame(() => {
        pointerFrameRef.current = null;
        const input = pendingPointerRef.current;
        if (input) flushPointerMove(input);
      });
    }
    event.preventDefault();
    event.stopPropagation();
  };
  const finishPointer = (event: PointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    if (pointerFrameRef.current !== null) {
      cancelWebFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (cancelled) {
      pendingPointerRef.current = null;
      source.pointerCancel?.();
    } else {
      flushPointerMove(pointerInput(event));
      source.pointerUp?.(pointerInput(event));
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointer(event, false)}
      onMouseDown={(event) => {
        if (pointerIdRef.current === null) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseMove={(event) => {
        if (pointerIdRef.current === null) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerCancel={(event) => finishPointer(event, true)}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        position: "absolute",
        inset: 0,
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
          left: `${clampedX}%`,
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
          top: `${clampedY}%`,
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
          left: `${clampedX}%`,
          top: `${clampedY}%`,
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
    const surface = paintSource?.getFrame() ?? layers[0] ?? null;
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
