import { createElement, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ForwardedRef, type ReactNode } from "react";
import {
  computeBitmapSize,
  intersectCellRects,
  type CellRect,
  type NativeChartBitmap,
} from "../../components/chart/native/chart-rasterizer";
import { getCachedKittySupport, ensureKittySupport } from "../../components/chart/native/kitty/support";
import { getNativeSurfaceManager } from "../../components/chart/native/surface/manager";
import {
  getRenderableCellRect,
  resolveNativeSurfaceVisibleRect,
  type NativeSurfaceRenderableNode,
} from "../../components/chart/native/surface/visibility";
import { useOptionalPaneInstanceId } from "../../state/app/context";
import { useNativeRenderer, type BoxRenderable, type MediaSurfaceHandle, type MediaSurfaceProps } from "../../ui";
import { loadOpenTuiImageBitmap } from "./image/loader";
import { startTerminalMpvPlayback } from "./media-decoder";

interface NativeRenderableNode extends BoxRenderable, NativeSurfaceRenderableNode {
  x: number;
  y: number;
  width: number;
  height: number;
  parent: NativeRenderableNode | null;
  onLifecyclePass: (() => void) | null;
}

interface SurfaceTarget {
  rect: CellRect;
  visibleRect: CellRect | null;
  pixelWidth: number;
  pixelHeight: number;
  sizeKey: string;
}

let nextMediaSurfaceId = 1;

function assignRef(ref: ForwardedRef<unknown>, value: unknown) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    (ref as { current: unknown }).current = value;
  }
}

function sameRect(left: CellRect | null, right: CellRect | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function sameTarget(left: SurfaceTarget | null, right: SurfaceTarget | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.sizeKey === right.sizeKey
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight
    && sameRect(left.rect, right.rect)
    && sameRect(left.visibleRect, right.visibleRect);
}

export const OpenTuiMediaSurface = forwardRef<unknown, MediaSurfaceProps>(function OpenTuiMediaSurface(
  rawProps,
  forwardedRef,
) {
  const {
    children,
    src,
    title: _title,
    poster,
    autoPlay = false,
    muted: mutedProp = true,
    mediaHandleRef,
    onPlaybackStateChange,
    onMutedChange,
    onError,
    ...props
  } = rawProps as MediaSurfaceProps & {
    children?: ReactNode;
    src?: string;
    poster?: string;
    autoPlay?: boolean;
    muted?: boolean;
    mediaHandleRef?: MediaSurfaceProps["mediaHandleRef"];
    onPlaybackStateChange?: MediaSurfaceProps["onPlaybackStateChange"];
    onMutedChange?: MediaSurfaceProps["onMutedChange"];
    onError?: MediaSurfaceProps["onError"];
  };
  const renderer = useNativeRenderer();
  const paneId = useOptionalPaneInstanceId();
  const nativeSurfaceManager = useMemo(() => getNativeSurfaceManager(renderer), [renderer]);
  const surfaceId = useRef(`opentui-media:${nextMediaSurfaceId++}`).current;
  const renderableRef = useRef<NativeRenderableNode | null>(null);
  const [kittySupport, setKittySupport] = useState<boolean | null>(() => getCachedKittySupport(renderer));
  const [target, setTarget] = useState<SurfaceTarget | null>(null);
  const [bitmapState, setBitmapState] = useState<{ key: string; bitmap: NativeChartBitmap } | null>(null);
  const [hasLiveFrame, setHasLiveFrame] = useState(false);
  const [active, setActive] = useState(autoPlay);
  const [muted, setMuted] = useState(mutedProp);
  const mediaSrc = typeof src === "string" ? src.trim() : "";
  const posterSrc = typeof poster === "string" ? poster.trim() : "";

  const setRenderableRef = useCallback((node: unknown) => {
    renderableRef.current = node as NativeRenderableNode | null;
    assignRef(forwardedRef, node);
  }, [forwardedRef]);

  useImperativeHandle(mediaHandleRef, (): MediaSurfaceHandle => ({
    async play() {
      setActive(true);
    },
    pause() {
      setActive(false);
      onPlaybackStateChange?.("paused");
    },
    async toggle() {
      setActive((current) => !current);
    },
    toggleMuted() {
      const next = !muted;
      setMuted(next);
      onMutedChange?.(next);
      return next;
    },
  }), [muted, onMutedChange, onPlaybackStateChange]);

  useEffect(() => {
    onMutedChange?.(muted);
  }, [muted, onMutedChange]);

  useEffect(() => {
    let cancelled = false;
    setKittySupport(getCachedKittySupport(renderer));
    ensureKittySupport(renderer).then((supported) => {
      if (!cancelled) setKittySupport(supported);
    });
    return () => {
      cancelled = true;
    };
  }, [renderer]);

  useEffect(() => {
    const renderable = renderableRef.current;
    if (!renderable || kittySupport !== true) {
      setTarget(null);
      return;
    }

    let mountTimer: Timer | null = null;
    const previousLifecyclePass = renderable.onLifecyclePass;
    const syncTarget = () => {
      const rect = getRenderableCellRect(renderable);
      if (!rect.width || !rect.height || !renderer.resolution || renderer.terminalWidth <= 0 || renderer.terminalHeight <= 0) {
        setTarget((current) => (current === null ? current : null));
        return;
      }

      const visibleRect = resolveNativeSurfaceVisibleRect(renderable, renderer.terminalWidth, renderer.terminalHeight);
      const clipped = visibleRect ? intersectCellRects(rect, visibleRect) : null;
      const bitmapSize = computeBitmapSize(rect, renderer.resolution, renderer.terminalWidth, renderer.terminalHeight);
      const nextTarget: SurfaceTarget = {
        rect,
        visibleRect: clipped,
        pixelWidth: bitmapSize.pixelWidth,
        pixelHeight: bitmapSize.pixelHeight,
        sizeKey: `${bitmapSize.pixelWidth}x${bitmapSize.pixelHeight}`,
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
      setTarget(null);
    };
  }, [kittySupport, renderer]);

  useEffect(() => {
    if (!target || !posterSrc || kittySupport !== true || active) return;

    let cancelled = false;
    loadOpenTuiImageBitmap(posterSrc, {
      width: target.pixelWidth,
      height: target.pixelHeight,
      objectFit: "contain",
    }).then((bitmap) => {
      if (!cancelled) setBitmapState({ key: `poster:${posterSrc}:${target.sizeKey}`, bitmap });
    }).catch(() => {
      if (!cancelled) setBitmapState(null);
    });

    return () => {
      cancelled = true;
    };
  }, [active, kittySupport, posterSrc, target]);

  useEffect(() => {
    if (!active || !mediaSrc || !target || kittySupport !== true) {
      if (!active) onPlaybackStateChange?.("paused");
      return;
    }

    let cancelled = false;
    onPlaybackStateChange?.("loading");
    nativeSurfaceManager.removeSurface(surfaceId);
    const stop = startTerminalMpvPlayback({
      url: mediaSrc,
      cols: target.rect.width,
      rows: target.rect.height,
      left: target.rect.x + 1,
      top: target.rect.y + 1,
      pixelWidth: target.pixelWidth,
      pixelHeight: target.pixelHeight,
      muted,
      renderer,
      onPlaying: () => {
        if (cancelled) return;
        setHasLiveFrame(true);
        onPlaybackStateChange?.("playing");
      },
      onError: (message) => {
        if (cancelled) return;
        setActive(false);
        onPlaybackStateChange?.("error");
        onError?.(message);
      },
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [active, kittySupport, mediaSrc, muted, nativeSurfaceManager, onError, onPlaybackStateChange, renderer, surfaceId, target]);

  useEffect(() => {
    return () => {
      nativeSurfaceManager.removeSurface(surfaceId);
    };
  }, [nativeSurfaceManager, surfaceId]);

  useEffect(() => {
    if (active) return;
    if (kittySupport !== true || !target?.visibleRect || !bitmapState) {
      nativeSurfaceManager.removeSurface(surfaceId);
      return;
    }

    nativeSurfaceManager.upsertSurface({
      id: surfaceId,
      paneId: paneId ?? "__global__",
      rect: target.rect,
      visibleRect: target.visibleRect,
      bitmap: bitmapState.bitmap,
      bitmapKey: bitmapState.key,
    });
    renderer.requestRender();
  }, [active, bitmapState, kittySupport, nativeSurfaceManager, paneId, renderer, surfaceId, target]);

  const showFallback = kittySupport !== true || (!hasLiveFrame && !bitmapState);

  return (createElement as any)("box", { ...props, ref: setRenderableRef }, showFallback ? children : null);
});
