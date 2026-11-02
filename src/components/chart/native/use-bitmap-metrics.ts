import { useCallback, useSyncExternalStore } from "react";
import type { NativeRendererHost, PixelResolution } from "../../../ui";

/** What a bitmap's pixel size and kitty support are worked out from. */
export interface NativeBitmapMetrics {
  resolution: PixelResolution | null;
  terminalWidth: number;
  terminalHeight: number;
  capabilities: unknown;
}

interface MetricsHub {
  snapshot: NativeBitmapMetrics | null;
  consumers: Set<() => void>;
  notify: () => void;
}

const hubs = new WeakMap<NativeRendererHost, MetricsHub>();

function hubFor(renderer: NativeRendererHost): MetricsHub {
  let hub = hubs.get(renderer);
  if (!hub) {
    const created: MetricsHub = {
      snapshot: null,
      consumers: new Set(),
      notify: () => {
        for (const consumer of created.consumers) consumer();
      },
    };
    hubs.set(renderer, created);
    hub = created;
  }
  return hub;
}

function readMetrics(renderer: NativeRendererHost): NativeBitmapMetrics {
  const hub = hubFor(renderer);
  const last = hub.snapshot;
  const resolution = renderer.resolution ?? null;
  const { terminalWidth, terminalHeight, capabilities } = renderer;
  if (
    last
    && last.terminalWidth === terminalWidth
    && last.terminalHeight === terminalHeight
    && last.capabilities === capabilities
    && (last.resolution === resolution || (!!last.resolution && !!resolution
      && last.resolution.width === resolution.width && last.resolution.height === resolution.height))
  ) return last;
  hub.snapshot = { resolution, terminalWidth, terminalHeight, capabilities };
  return hub.snapshot;
}

// One listener trio per renderer however many bitmaps watch it, as in renderer-selection.
function subscribe(renderer: NativeRendererHost, onChange: () => void): () => void {
  const hub = hubFor(renderer);
  if (hub.consumers.size === 0) {
    renderer.on("resize", hub.notify);
    renderer.on("resolution", hub.notify);
    renderer.on("capabilities", hub.notify);
  }
  hub.consumers.add(onChange);
  return () => {
    hub.consumers.delete(onChange);
    if (hub.consumers.size > 0) return;
    renderer.off("resize", hub.notify);
    renderer.off("resolution", hub.notify);
    renderer.off("capabilities", hub.notify);
  };
}

/**
 * The renderer's pixel resolution, cell grid and capabilities, re-rendering the
 * caller when a resize, a font zoom or a late terminal reply changes them. A
 * bitmap sized from these during render needs this rather than reading them off
 * the renderer, or a parent that stops re-rendering leaves it at its old size.
 */
export function useNativeBitmapMetrics(renderer: NativeRendererHost): NativeBitmapMetrics {
  const subscribeToRenderer = useCallback((onChange: () => void) => subscribe(renderer, onChange), [renderer]);
  const getSnapshot = useCallback(() => readMetrics(renderer), [renderer]);
  return useSyncExternalStore(subscribeToRenderer, getSnapshot, getSnapshot);
}
