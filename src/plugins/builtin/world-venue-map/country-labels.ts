/**
 * Which country names the desktop and web map write, and where. Names come
 * from Natural Earth's label points, most prominent first, each with the
 * web-map zoom it first shows at. A name shows once the map is that close (a
 * little before), sits wholly inside the map, and keeps clear of the names
 * already placed and of the selected or hovered marker. Same view, same names.
 */
import type { CountryLabel } from "./basemap";

export interface PlacedCountryLabel {
  name: string;
  longitude: number;
  latitude: number;
}

/** A marker the names keep clear of, in pixels from the map's top left. */
export interface LabelObstacle {
  x: number;
  y: number;
  radius: number;
}

export const COUNTRY_LABEL_FONT_PX = 10;
/** The map's font is monospaced: every character advances this much of the font size. */
const CHARACTER_EM = 0.6;
/** Room kept around a name, so two never touch. */
const GAP_PX = 6;
/** Names show at Natural Earth's own zoom; this moves the threshold earlier (positive) or later. */
const ZOOM_LEAD = 0;
/** The largest countries are named on any world view, room permitting. */
const WORLD_VIEW_MIN_ZOOM = 1.7;
/** Never more names than this on one view. */
const MAX_LABELS = 60;

/** The web-map zoom (256 px tiles for 360 degrees) of a map drawn at this many pixels per degree. */
export function webMapZoom(pxPerDegree: number): number {
  return Math.log2((Math.max(pxPerDegree, 1e-9) * 360) / 256);
}

export function layoutCountryLabels(
  labels: readonly CountryLabel[],
  options: {
    pxPerDegree: number;
    /** Where a longitude and latitude fall, in pixels from the map's top left. */
    toPixels: (longitude: number, latitude: number) => { x: number; y: number };
    widthPx: number;
    heightPx: number;
    obstacles?: readonly LabelObstacle[];
    fontPx?: number;
  },
): PlacedCountryLabel[] {
  const { toPixels, widthPx, heightPx, obstacles = [] } = options;
  const fontPx = options.fontPx ?? COUNTRY_LABEL_FONT_PX;
  if (!(widthPx > 0 && heightPx > 0 && options.pxPerDegree > 0)) return [];
  const threshold = Math.max(webMapZoom(options.pxPerDegree) + ZOOM_LEAD, WORLD_VIEW_MIN_ZOOM);
  const taken: [number, number, number, number][] = [];
  const placed: PlacedCountryLabel[] = [];
  for (const [name, longitude, latitude, minZoom] of labels) {
    if (placed.length >= MAX_LABELS) break;
    if (minZoom > threshold) continue;
    const { x, y } = toPixels(longitude, latitude);
    const halfWidth = (name.length * fontPx * CHARACTER_EM) / 2 + GAP_PX / 2;
    const halfHeight = fontPx / 2 + GAP_PX / 4;
    const box: [number, number, number, number] = [x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight];
    if (box[0] < 0 || box[1] < 0 || box[2] > widthPx || box[3] > heightPx) continue;
    if (taken.some((other) => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) continue;
    if (obstacles.some((marker) => circleMeetsBox(marker, box))) continue;
    taken.push(box);
    placed.push({ name, longitude, latitude });
  }
  return placed;
}

function circleMeetsBox(circle: LabelObstacle, box: readonly [number, number, number, number]): boolean {
  const nearestX = Math.max(box[0], Math.min(circle.x, box[2]));
  const nearestY = Math.max(box[1], Math.min(circle.y, box[3]));
  return Math.hypot(circle.x - nearestX, circle.y - nearestY) < circle.radius;
}
