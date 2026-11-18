import { useEffect, useMemo, useRef, useState } from "react";
import { type GeoLayerInfo, type GeoLayersPayload, type GeoRequest } from "../../../api-client/geo";
import { useCloudDisplayScope } from "../../../api-client/plan-access";
import { useAsyncResource } from "../../../react/async-resource";
import { cloudGeoRequest, loadMapCatalog } from "./client";
import { GeoLayerFeed, type GeoFeedOptions, type GeoLayerState } from "./feed";
import type { GeoView } from "./layers";

export interface GeoCatalogState {
  catalog: GeoLayersPayload | null;
  /** The server has answered (with layers or without); before that a preset waits. */
  settled: boolean;
}

/**
 * The layer catalog, asked once per pane and kept for a few minutes. A server
 * without geo layers settles to null without an error, so the pane stays the
 * venue map.
 */
export function useGeoCatalog(request: GeoRequest = cloudGeoRequest): GeoCatalogState {
  const scope = useCloudDisplayScope();
  const load = useMemo(() => (force: boolean) => loadMapCatalog(request, force), [request, scope]);
  const catalog = useAsyncResource(load, {
    savedCopy: scope && request === cloudGeoRequest ? { key: ["map-catalog", scope] } : null,
  });
  return { catalog: catalog.data, settled: !catalog.loading };
}

/** Feature state for each layer on, kept in step with the view and the pane's visibility. */
export function useGeoLayerFeed(
  layers: readonly GeoLayerInfo[],
  view: GeoView,
  active: boolean,
  options: GeoFeedOptions & { request?: GeoRequest } = {},
): GeoLayerState[] {
  const [, setVersion] = useState(0);
  const canAccessRef = useRef(options.canAccess);
  canAccessRef.current = options.canAccess;
  const feed = useMemo(() => new GeoLayerFeed(
    options.request ?? cloudGeoRequest,
    () => setVersion((version) => version + 1),
    { ...options, canAccess: (layer) => canAccessRef.current?.(layer) ?? true },
  ), [options.request]);
  useEffect(() => () => feed.dispose(), [feed]);
  useEffect(() => {
    feed.update(layers, view, active);
  }, [active, feed, layers, view]);
  return feed.snapshot();
}
