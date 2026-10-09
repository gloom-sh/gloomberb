/**
 * The land under the desktop and web map: a quiet fill, 1 px coastlines and
 * fainter borders, at 1:50m for the world and 1:10m for the tiles in view once
 * zoomed in. Until a level arrives the level below stands in for it: the
 * terminal's outline before the 1:50m chunk, 1:50m over tiles still loading.
 */
import { memo, useEffect, useId, useMemo, useState } from "react";
import {
  basemapLevel,
  GRATICULE_MAX_PX_PER_DEGREE,
  loadDetailIndex,
  loadDetailTile,
  loadWorldBasemap,
  TILE_CACHE_SIZE,
  tilesInView,
  type BasemapPaths,
  type DetailTile,
  type GeoBox,
} from "./basemap";
import { matrixTransform, type MapMatrix } from "./geo-svg";
import { WORLD_OUTLINES } from "./world-outlines";

export interface BasemapPalette {
  land: string;
  coast: string;
  border: string;
  /** Country names. */
  label: string;
}

interface BasemapLayerProps {
  matrix: MapMatrix;
  view: GeoBox;
  pxPerDegree: number;
  palette: BasemapPalette;
}

let outlinePath: BasemapPaths | null = null;

/** The terminal's 1:110m outlines in degrees, shown for the moment before 1:50m arrives. */
function fallbackPaths(): BasemapPaths {
  if (outlinePath) return outlinePath;
  let land = "";
  for (const outline of WORLD_OUTLINES) {
    let previous: number | null = null;
    for (const [longitude, latitude] of outline) {
      const lat = Math.max(-60, latitude);
      land += `${previous === null || Math.abs(longitude - previous) > 180 ? "M" : "L"}${longitude} ${-lat}`;
      previous = longitude;
    }
  }
  outlinePath = { land: "", coast: land, borders: "" };
  return outlinePath;
}

const GRATICULE = (() => {
  let path = "";
  for (let longitude = -180; longitude <= 180; longitude += 30) path += `M${longitude} 60L${longitude} -85`;
  for (let latitude = -30; latitude <= 60; latitude += 30) path += `M-180 ${-latitude}L180 ${-latitude}`;
  return path;
})();

function useWorldPaths(): BasemapPaths | null {
  const [paths, setPaths] = useState<BasemapPaths | null>(null);
  useEffect(() => {
    let current = true;
    loadWorldBasemap().then((loaded) => {
      if (current) setPaths(loaded);
    }, () => {});
    return () => {
      current = false;
    };
  }, []);
  return paths;
}

function useDetailTiles(active: boolean, view: GeoBox): { tiles: DetailTile[]; loaded: ReadonlyMap<string, BasemapPaths> } {
  const [index, setIndex] = useState<readonly DetailTile[] | null>(null);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, BasemapPaths>>(() => new Map());
  useEffect(() => {
    if (!active || index) return;
    let current = true;
    loadDetailIndex().then((tiles) => {
      if (current) setIndex(tiles);
    }, () => {});
    return () => {
      current = false;
    };
  }, [active, index]);
  const tiles = active && index ? tilesInView(index, view) : [];
  const key = tiles.map((tile) => tile.id).join(",");
  useEffect(() => {
    if (!key || !index) return;
    let current = true;
    for (const tile of index.filter((entry) => key.split(",").includes(entry.id))) {
      loadDetailTile(tile).then((paths) => {
        if (!current) return;
        setLoaded((previous) => {
          if (previous.get(tile.id) === paths) return previous;
          // Newest last; the map keeps no more decoded tiles than the cache does.
          const next = new Map(previous);
          next.delete(tile.id);
          next.set(tile.id, paths);
          while (next.size > TILE_CACHE_SIZE) next.delete(next.keys().next().value!);
          return next;
        });
      }, () => {});
    }
    return () => {
      current = false;
    };
  }, [index, key]);
  return useMemo(() => ({ tiles, loaded }), [key, loaded]);
}

const BasemapPathsView = memo(function BasemapPathsView({ paths, palette, clipPath }: { paths: BasemapPaths; palette: BasemapPalette; clipPath?: string }) {
  return (
    <g clipPath={clipPath}>
      {paths.land ? <path d={paths.land} fill={palette.land} fillRule="evenodd" stroke="none" /> : null}
      {paths.borders ? (
        <path d={paths.borders} fill="none" stroke={palette.border} strokeWidth={0.7} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      ) : null}
      {paths.coast ? <path d={paths.coast} fill="none" stroke={palette.coast} strokeWidth={1} strokeLinejoin="round" vectorEffect="non-scaling-stroke" /> : null}
    </g>
  );
});

export function BasemapLayer({ matrix, view, pxPerDegree, palette }: BasemapLayerProps) {
  const clipId = `gloom-basemap-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const world = useWorldPaths();
  const level = basemapLevel(pxPerDegree);
  const { tiles, loaded } = useDetailTiles(level === "detail", view);
  const ready = tiles.filter((tile) => loaded.has(tile.id));
  const missing = tiles.filter((tile) => !loaded.has(tile.id));
  // While tiles load, 1:50m fills in only where they are missing.
  const partial = level === "detail" && missing.length > 0 && ready.length > 0;
  const showWorld = level === "world" || !tiles.length || missing.length > 0;
  return (
    <g
      transform={matrixTransform(matrix)}
      data-gloom-role="basemap"
      data-basemap-level={level === "detail" && tiles.length && !missing.length ? "detail" : world ? "world" : "outline"}
    >
      {pxPerDegree <= GRATICULE_MAX_PX_PER_DEGREE ? (
        <path d={GRATICULE} fill="none" stroke={palette.border} strokeOpacity={0.45} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
      ) : null}
      {partial ? (
        <defs>
          <clipPath id={clipId}>
            {missing.map((tile) => <rect key={tile.id} x={tile.box[0]} y={-tile.box[3]} width={tile.box[2] - tile.box[0]} height={tile.box[3] - tile.box[1]} />)}
          </clipPath>
        </defs>
      ) : null}
      {showWorld ? <BasemapPathsView paths={world ?? fallbackPaths()} palette={palette} clipPath={partial ? `url(#${clipId})` : undefined} /> : null}
      {/* One path per tile: a tile that comes into view adds its own paths and leaves the others alone. */}
      {level === "detail" ? ready.map((tile) => <BasemapPathsView key={tile.id} paths={loaded.get(tile.id)!} palette={palette} />) : null}
    </g>
  );
}
