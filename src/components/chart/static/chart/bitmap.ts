import { useMemo } from "react";
import { useNativeRenderer, useUiCapabilities } from "../../../../ui";
import { useOptionalAppSelector } from "../../../../state/app/context";
import type { ChartRendererPreference } from "../../core/types";
import { resolveNativeBitmapSize, shouldRenderNativeBitmap } from "../../native/bitmap-support";
import { useResolvedChartRendererState } from "../../native/renderer-selection";

export interface StaticChartBitmapSize {
  pixelWidth: number;
  pixelHeight: number;
}

export function useStaticChartBitmapSize(width: number, height: number): StaticChartBitmapSize | null {
  const {
    canvasCharts,
    nativeCharts,
    cellWidthPx = 8,
    cellHeightPx = 18,
    pixelRatio = 1,
  } = useUiCapabilities();
  const nativeRenderer = useNativeRenderer();
  const preferredRenderer = useOptionalAppSelector<ChartRendererPreference | null>(
    (state) => state.config.chartPreferences.renderer,
    null,
  );
  const rendererState = useResolvedChartRendererState(
    nativeCharts === true ? preferredRenderer ?? "auto" : "braille",
    nativeRenderer,
  );
  const rendererCapabilities = nativeRenderer.capabilities;
  const rendererResolution = nativeRenderer.resolution;
  const rendererTerminalWidth = nativeRenderer.terminalWidth;
  const rendererTerminalHeight = nativeRenderer.terminalHeight;

  return useMemo(() => {
    const nativeRendererActive = preferredRenderer === null || rendererState.renderer === "kitty";
    if (nativeRendererActive && shouldRenderNativeBitmap(nativeRenderer, nativeCharts === true)) {
      return resolveNativeBitmapSize({
        width,
        height,
        resolution: rendererResolution,
        terminalWidth: rendererTerminalWidth,
        terminalHeight: rendererTerminalHeight,
        cellWidthPx,
        cellHeightPx,
        pixelRatio,
      });
    }
    if (!canvasCharts) return null;
    const scale = Math.max(1, pixelRatio);
    return {
      pixelWidth: Math.max(1, Math.round(width * cellWidthPx * scale)),
      pixelHeight: Math.max(1, Math.round(height * cellHeightPx * scale)),
    };
  }, [
    canvasCharts,
    cellHeightPx,
    cellWidthPx,
    height,
    nativeCharts,
    nativeRenderer,
    pixelRatio,
    preferredRenderer,
    rendererCapabilities,
    rendererResolution,
    rendererState.renderer,
    rendererTerminalHeight,
    rendererTerminalWidth,
    width,
  ]);
}
