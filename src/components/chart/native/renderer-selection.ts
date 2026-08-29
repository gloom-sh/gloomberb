import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { type PixelResolution } from "../../../ui";
import { type NativeRendererHost as CliRenderer } from "../../../ui";
import type { ChartRendererPreference, ResolvedChartRenderer } from "../core/types";
import { ensureKittySupport, getCachedKittySupport } from "./kitty/support";

export interface ResolvedChartRendererState {
  renderer: ResolvedChartRenderer;
  nativeUnavailable: boolean;
  nativeReady: boolean;
}

export function resolveChartRendererState(
  preference: ChartRendererPreference,
  kittySupport: boolean | null,
  resolution: PixelResolution | null,
): ResolvedChartRendererState {
  const nativeReady = kittySupport === true && resolution !== null;
  if (preference === "braille") {
    return { renderer: "braille", nativeUnavailable: false, nativeReady };
  }
  if (preference === "kitty") {
    return { renderer: nativeReady ? "kitty" : "braille", nativeUnavailable: !nativeReady && kittySupport !== null, nativeReady };
  }
  return { renderer: nativeReady ? "kitty" : "braille", nativeUnavailable: false, nativeReady };
}

interface NativeChartRendererSnapshot {
  kittySupport: boolean | null;
  resolution: PixelResolution | null;
}

function readNativeChartRendererSnapshot(renderer: CliRenderer): NativeChartRendererSnapshot {
  return {
    kittySupport: getCachedKittySupport(renderer),
    resolution: renderer.resolution,
  };
}

function sameResolution(left: PixelResolution | null, right: PixelResolution | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.width === right.width && left.height === right.height;
}

function sameSnapshot(left: NativeChartRendererSnapshot, right: NativeChartRendererSnapshot): boolean {
  return left.kittySupport === right.kittySupport
    && sameResolution(left.resolution, right.resolution);
}

function shouldQueryKittySupport(
  preference: ChartRendererPreference,
  renderer: CliRenderer,
  snapshot: NativeChartRendererSnapshot,
): boolean {
  return !renderer.isDestroyed && preference !== "braille" && snapshot.kittySupport === null;
}

/**
 * One capabilities/resolution/resize trio per CliRenderer. Chart surfaces used to
 * each attach their own listeners, so multi-chart panes blew past MaxListeners(10).
 */
interface RendererReadinessHub {
  snapshot: NativeChartRendererSnapshot;
  consumers: Set<() => void>;
  attached: boolean;
  refresh: () => void;
}

const readinessHubs = new WeakMap<CliRenderer, RendererReadinessHub>();

function getReadinessHub(renderer: CliRenderer): RendererReadinessHub {
  let hub = readinessHubs.get(renderer);
  if (hub) return hub;

  hub = {
    snapshot: readNativeChartRendererSnapshot(renderer),
    consumers: new Set(),
    attached: false,
    refresh: () => {},
  };
  hub.refresh = () => {
    const next = readNativeChartRendererSnapshot(renderer);
    if (sameSnapshot(hub!.snapshot, next)) return;
    hub!.snapshot = next;
    for (const notify of hub!.consumers) notify();
  };
  readinessHubs.set(renderer, hub);
  return hub;
}

function subscribeRendererReadiness(renderer: CliRenderer, onStoreChange: () => void): () => void {
  const hub = getReadinessHub(renderer);
  const wasEmpty = hub.consumers.size === 0;
  hub.consumers.add(onStoreChange);

  if (wasEmpty && !hub.attached) {
    hub.attached = true;
    renderer.on("capabilities", hub.refresh);
    renderer.on("resolution", hub.refresh);
    renderer.on("resize", hub.refresh);
    hub.refresh();
  }

  return () => {
    hub.consumers.delete(onStoreChange);
    if (hub.consumers.size === 0 && hub.attached) {
      renderer.off("capabilities", hub.refresh);
      renderer.off("resolution", hub.refresh);
      renderer.off("resize", hub.refresh);
      hub.attached = false;
    }
  };
}

function getRendererReadinessSnapshot(renderer: CliRenderer): NativeChartRendererSnapshot {
  return getReadinessHub(renderer).snapshot;
}

export function useResolvedChartRendererState(
  preference: ChartRendererPreference,
  renderer: CliRenderer,
): ResolvedChartRendererState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeRendererReadiness(renderer, onStoreChange),
    [renderer],
  );

  const getSnapshot = useCallback(
    () => getRendererReadinessSnapshot(renderer),
    [renderer],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const current = getRendererReadinessSnapshot(renderer);
    if (!shouldQueryKittySupport(preference, renderer, current)) return;
    let cancelled = false;
    ensureKittySupport(renderer).then(() => {
      if (!cancelled) getReadinessHub(renderer).refresh();
    }).catch(() => {
      if (!cancelled) getReadinessHub(renderer).refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [preference, renderer, snapshot.kittySupport]);

  return useMemo(
    () => resolveChartRendererState(preference, snapshot.kittySupport, snapshot.resolution),
    [preference, snapshot.kittySupport, snapshot.resolution],
  );
}
