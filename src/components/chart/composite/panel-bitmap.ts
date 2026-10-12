import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NativeChartBitmap } from "../native/chart-rasterizer";
import type { StaticChartBitmapSize } from "./bitmap";
import { renderCompositePanelBitmap } from "./rasterizer";
import type { CompositeChartColors, CompositePanelScene } from "./types";

// A short resize-only delay coalesces geometry churn without delaying
// live-data paints or depending on a foreground animation frame.
const DESKTOP_BITMAP_RESIZE_DEBOUNCE_MS = 32;

function renderPanelBitmap(
  panel: CompositePanelScene,
  bitmapSize: StaticChartBitmapSize,
  colors: CompositeChartColors,
  snapGridToRows = false,
): NativeChartBitmap {
  return renderCompositePanelBitmap(panel, {
    pixelWidth: bitmapSize.pixelWidth,
    pixelHeight: bitmapSize.pixelHeight,
    colors,
    snapGridToRows,
  });
}

export function useCompositePanelBitmap({
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
  const desktopRenderedColorsRef = useRef<CompositeChartColors | null>(null);
  /** A bitmap was drawn that the browser has not painted yet: a new size before that paint draws at once, not after the debounce. */
  const desktopUnpaintedRef = useRef(false);
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
    return renderPanelBitmap(panel, bitmapSize, colors, true);
  }, [bitmapSize, colors, isDesktopWeb, panel]);

  // A newly mounted plot, or a new palette, must have pixels before the
  // browser paints. Only a resize may keep the previous bitmap briefly.
  useLayoutEffect(() => {
    const cancelRender = () => {
      if (desktopRenderTimerRef.current === null) return;
      clearTimeout(desktopRenderTimerRef.current);
      desktopRenderTimerRef.current = null;
    };
    const render = () => {
      if (!desktopActiveRef.current) return;
      const input = desktopRenderInputRef.current;
      if (!input) return;
      const next = renderPanelBitmap(
        input.panel,
        { pixelWidth: input.pixelWidth, pixelHeight: input.pixelHeight },
        input.colors,
      );
      desktopRenderedSizeRef.current = {
        pixelWidth: input.pixelWidth,
        pixelHeight: input.pixelHeight,
      };
      desktopRenderedColorsRef.current = input.colors;
      desktopBitmapRef.current = next;
      setDesktopBitmap(next);
      // Painted by the end of the frame after next: a chart that fills its
      // box takes its measured size in the first frame, before that paint.
      desktopUnpaintedRef.current = true;
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => requestAnimationFrame(() => { desktopUnpaintedRef.current = false; }));
      } else {
        desktopUnpaintedRef.current = false;
      }
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

    if (!desktopBitmapRef.current || sizeAlreadyRendered || desktopRenderedColorsRef.current !== colors || desktopUnpaintedRef.current) {
      cancelRender();
      render();
      return;
    }

    if (!requestedSizeChanged || desktopRenderTimerRef.current !== null) return;
    desktopRenderTimerRef.current = globalThis.setTimeout(() => {
      desktopRenderTimerRef.current = null;
      render();
    }, DESKTOP_BITMAP_RESIZE_DEBOUNCE_MS);
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
