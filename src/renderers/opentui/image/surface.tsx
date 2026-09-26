import { createElement, forwardRef, useEffect, useMemo, useRef, useState } from "react";
import type { NativeChartBitmap } from "../../../components/chart/native/chart-rasterizer";
import { getCachedKittySupport, ensureKittySupport } from "../../../components/chart/native/kitty/support";
import { useNativeRenderer, type ImageSurfaceProps } from "../../../ui";
import { useNativeSurface, useNativeSurfaceTarget, type CellInsets } from "../native-surface";
import { loadOpenTuiImageBitmap } from "./loader";

let nextImageSurfaceId = 1;

function readInset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function resolveInsets(props: Record<string, unknown>): CellInsets {
  const border = props.border ? 1 : 0;
  const padding = readInset(props.padding);
  const paddingX = readInset(props.paddingX ?? padding);
  const paddingY = readInset(props.paddingY ?? padding);
  return {
    top: border + readInset(props.paddingTop ?? paddingY),
    right: border + readInset(props.paddingRight ?? paddingX),
    bottom: border + readInset(props.paddingBottom ?? paddingY),
    left: border + readInset(props.paddingLeft ?? paddingX),
  };
}

export const OpenTuiImageSurface = forwardRef<unknown, ImageSurfaceProps>(function OpenTuiImageSurface(
  { children, src, alt: _alt, objectFit = "contain", ...props },
  forwardedRef,
) {
  const renderer = useNativeRenderer();
  const surfaceId = useRef(`opentui-image:${nextImageSurfaceId++}`).current;
  const [kittySupport, setKittySupport] = useState<boolean | null>(() => getCachedKittySupport(renderer));
  const [bitmapState, setBitmapState] = useState<{ key: string; bitmap: NativeChartBitmap } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const imageSrc = typeof src === "string" ? src.trim() : "";
  const resolvedObjectFit = objectFit === "cover" ? "cover" : "contain";
  const insets = useMemo(() => resolveInsets(props), [
    props.border,
    props.padding,
    props.paddingX,
    props.paddingY,
    props.paddingTop,
    props.paddingRight,
    props.paddingBottom,
    props.paddingLeft,
  ]);

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
    setLoadFailed(false);
    setBitmapState(null);
  }, [imageSrc]);

  const { target, setRenderableRef } = useNativeSurfaceTarget(
    renderer,
    forwardedRef,
    imageSrc && kittySupport === true ? `${imageSrc}\n${resolvedObjectFit}` : null,
    insets,
  );

  useEffect(() => {
    if (!target || !imageSrc || kittySupport !== true) {
      setBitmapState(null);
      return;
    }

    let cancelled = false;
    setBitmapState((current) => (current?.key === target.bitmapKey ? current : null));
    loadOpenTuiImageBitmap(imageSrc, {
      width: target.pixelWidth,
      height: target.pixelHeight,
      objectFit: resolvedObjectFit,
    }).then((bitmap) => {
      if (!cancelled) {
        setLoadFailed(false);
        setBitmapState({ key: target.bitmapKey, bitmap });
      }
    }).catch(() => {
      if (!cancelled) {
        setLoadFailed(true);
        setBitmapState(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [imageSrc, kittySupport, resolvedObjectFit, target]);

  const readyBitmap = kittySupport === true && !loadFailed && target && bitmapState?.key === target.bitmapKey
    ? bitmapState.bitmap
    : null;
  useNativeSurface(renderer, surfaceId, target, readyBitmap);

  return (createElement as any)("box", { ...props, ref: setRenderableRef }, readyBitmap ? null : children);
});
