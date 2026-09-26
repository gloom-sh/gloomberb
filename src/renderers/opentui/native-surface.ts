import { useCallback, useEffect, useMemo, useRef, useState, type ForwardedRef } from "react";
import {
  computeBitmapSize,
  intersectCellRects,
  sameCellRect,
  type CellRect,
  type NativeChartBitmap,
} from "../../components/chart/native/chart-rasterizer";
import { getNativeSurfaceManager } from "../../components/chart/native/surface/manager";
import {
  getRenderableCellRect,
  resolveNativeSurfaceVisibleRect,
  type NativeSurfaceRenderableNode,
} from "../../components/chart/native/surface/visibility";
import { assignRef } from "../../react/assign-ref";
import { useOptionalPaneInstanceId } from "../../state/app/context";
import type { BoxRenderable, NativeRendererHost } from "../../ui";

interface NativeRenderableNode extends BoxRenderable, NativeSurfaceRenderableNode {
  x: number;
  y: number;
  width: number;
  height: number;
  parent: NativeRenderableNode | null;
  onLifecyclePass: (() => void) | null;
}

export interface NativeSurfaceTarget {
  rect: CellRect;
  visibleRect: CellRect | null;
  pixelWidth: number;
  pixelHeight: number;
  /** The source key plus the pixel size, so a resize uploads a fresh bitmap. */
  bitmapKey: string;
}

export interface CellInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function sameTarget(left: NativeSurfaceTarget | null, right: NativeSurfaceTarget | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.bitmapKey === right.bitmapKey
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight
    && sameCellRect(left.rect, right.rect)
    && sameCellRect(left.visibleRect, right.visibleRect);
}

function insetRect(rect: CellRect, insets: CellInsets | undefined): CellRect | null {
  if (!insets) return rect;
  const width = rect.width - insets.left - insets.right;
  const height = rect.height - insets.top - insets.bottom;
  if (width <= 0 || height <= 0) return null;
  return {
    x: rect.x + insets.left,
    y: rect.y + insets.top,
    width,
    height,
  };
}

/**
 * Where a terminal image surface should draw, re-measured on every lifecycle
 * pass so it follows layout, scrolling and clipping.
 *
 * `sourceKey` names what will be drawn; null means nothing is, which clears
 * the target. `insets` keep the image inside a border or padding and must be
 * memoized. Pass `setRenderableRef` as the ref of the box being drawn over.
 */
export function useNativeSurfaceTarget(
  renderer: NativeRendererHost,
  forwardedRef: ForwardedRef<unknown>,
  sourceKey: string | null,
  insets?: CellInsets,
): { target: NativeSurfaceTarget | null; setRenderableRef: (node: unknown) => void } {
  const renderableRef = useRef<NativeRenderableNode | null>(null);
  const [target, setTarget] = useState<NativeSurfaceTarget | null>(null);

  const setRenderableRef = useCallback((node: unknown) => {
    renderableRef.current = node as NativeRenderableNode | null;
    assignRef(forwardedRef, node);
  }, [forwardedRef]);

  useEffect(() => {
    const renderable = renderableRef.current;
    if (!renderable || sourceKey === null) {
      setTarget(null);
      return;
    }

    let mountTimer: Timer | null = null;
    const previousLifecyclePass = renderable.onLifecyclePass;
    const syncTarget = () => {
      const rect = insetRect(getRenderableCellRect(renderable), insets);
      if (!rect || !renderer.resolution || renderer.terminalWidth <= 0 || renderer.terminalHeight <= 0) {
        setTarget((current) => (current === null ? current : null));
        return;
      }

      const outerVisibleRect = resolveNativeSurfaceVisibleRect(renderable, renderer.terminalWidth, renderer.terminalHeight);
      const size = computeBitmapSize(rect, renderer.resolution, renderer.terminalWidth, renderer.terminalHeight);
      const nextTarget: NativeSurfaceTarget = {
        rect,
        visibleRect: outerVisibleRect ? intersectCellRects(rect, outerVisibleRect) : null,
        pixelWidth: size.pixelWidth,
        pixelHeight: size.pixelHeight,
        bitmapKey: `${sourceKey}:${size.pixelWidth}x${size.pixelHeight}`,
      };
      setTarget((current) => (sameTarget(current, nextTarget) ? current : nextTarget));
    };
    const lifecyclePass = () => {
      previousLifecyclePass?.();
      syncTarget();
    };

    renderable.onLifecyclePass = lifecyclePass;
    renderer.registerLifecyclePass(renderable);
    syncTarget();
    mountTimer = setTimeout(() => {
      syncTarget();
      renderer.requestRender();
    }, 0);

    return () => {
      if (mountTimer) clearTimeout(mountTimer);
      if (renderable.onLifecyclePass === lifecyclePass) {
        renderable.onLifecyclePass = previousLifecyclePass;
      }
      renderer.unregisterLifecyclePass(renderable);
    };
  }, [insets, renderer, sourceKey]);

  return { target, setRenderableRef };
}

/**
 * Keeps one kitty surface in step with its target: drawn while the target is
 * on screen and a bitmap is ready, removed otherwise and on unmount.
 */
export function useNativeSurface(
  renderer: NativeRendererHost,
  surfaceId: string,
  target: NativeSurfaceTarget | null,
  bitmap: NativeChartBitmap | null,
): void {
  const paneId = useOptionalPaneInstanceId();
  const nativeSurfaceManager = useMemo(() => getNativeSurfaceManager(renderer), [renderer]);

  useEffect(() => {
    return () => {
      nativeSurfaceManager.removeSurface(surfaceId);
    };
  }, [nativeSurfaceManager, surfaceId]);

  useEffect(() => {
    if (!target?.visibleRect || !bitmap) {
      nativeSurfaceManager.removeSurface(surfaceId);
      return;
    }

    nativeSurfaceManager.upsertSurface({
      id: surfaceId,
      paneId: paneId ?? "__global__",
      rect: target.rect,
      visibleRect: target.visibleRect,
      bitmap,
      bitmapKey: target.bitmapKey,
    });
    renderer.requestRender();
  }, [bitmap, nativeSurfaceManager, paneId, renderer, surfaceId, target]);
}
