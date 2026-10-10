import { describe, expect, test } from "bun:test";
import { dirname, join } from "path";
import type { CountryLabel } from "./basemap";
import { layoutCountryLabels, webMapZoom } from "./country-labels";
import { COUNTRY_LABELS } from "./natural-earth/labels.chunk";

/** An equirectangular map of the world `widthPx` wide, centred on 0°, 12.5°N, at `zoom` times the world. */
function view(widthPx: number, heightPx: number, zoom = 1, center: [number, number] = [0, 12.5]) {
  const pxPerDegree = (widthPx / 360) * zoom;
  return {
    pxPerDegree,
    widthPx,
    heightPx,
    toPixels: (longitude: number, latitude: number) => ({
      x: widthPx / 2 + (longitude - center[0]) * pxPerDegree,
      y: heightPx / 2 - (latitude - center[1]) * pxPerDegree,
    }),
  };
}

const names = (labels: { name: string }[]) => labels.map((label) => label.name);

describe("country labels", () => {
  test("the world view names only the largest countries; zooming in adds the smaller ones", () => {
    const world = names(layoutCountryLabels(COUNTRY_LABELS, view(900, 400)));
    expect(world).toEqual(expect.arrayContaining(["Russia", "China", "Brazil", "Australia", "Canada"]));
    expect(world).not.toContain("Belgium");
    expect(world).not.toContain("Luxembourg");

    // Over Europe at sixteen times the world, about a web map's zoom 5.
    const europe = names(layoutCountryLabels(COUNTRY_LABELS, view(900, 600, 16, [8, 49])));
    expect(webMapZoom(view(900, 600, 16).pxPerDegree)).toBeGreaterThan(5);
    expect(europe).toEqual(expect.arrayContaining(["Belgium", "Germany", "Switzerland"]));
    expect(europe).not.toContain("Russia");
  });

  test("names never overlap each other, sit wholly in the map, and give way to a selected marker", () => {
    const options = view(390, 300, 2, [10, 45]);
    const placed = layoutCountryLabels(COUNTRY_LABELS, options);
    expect(placed.length).toBeGreaterThan(3);
    const boxes = placed.map(({ name, longitude, latitude }) => {
      const { x, y } = options.toPixels(longitude, latitude);
      const half = (name.length * 10 * 0.6) / 2;
      return [x - half, y - 5, x + half, y + 5] as const;
    });
    for (const [index, box] of boxes.entries()) {
      expect(box[0]).toBeGreaterThanOrEqual(0);
      expect(box[2]).toBeLessThanOrEqual(390);
      for (const other of boxes.slice(index + 1)) {
        expect(box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1]).toBe(false);
      }
    }
    const first = placed[0]!;
    const marker = { ...options.toPixels(first.longitude, first.latitude), radius: 14 };
    expect(names(layoutCountryLabels(COUNTRY_LABELS, { ...options, obstacles: [marker] }))).not.toContain(first.name);
  });

  test("the same view gives the same names, most prominent first when two collide", () => {
    const options = view(900, 600, 4, [10, 48]);
    expect(layoutCountryLabels(COUNTRY_LABELS, options)).toEqual(layoutCountryLabels(COUNTRY_LABELS, options));
    const clash: CountryLabel[] = [["Big", 0, 0, 1.7, 2], ["Small", 0, 0, 1.7, 5]];
    expect(names(layoutCountryLabels(clash, view(400, 300)))).toEqual(["Big"]);
    expect(layoutCountryLabels(clash, view(0, 0))).toEqual([]);
  });

  test("the names are a lazy chunk the map index loads, not part of the map's own code", async () => {
    const index = await Bun.file(join(dirname(import.meta.path), "natural-earth/index.chunk.ts")).text();
    expect(index).toContain('export const loadLabels = () => import("./labels.chunk.js");');
    const map = await Bun.file(join(dirname(import.meta.path), "map.tsx")).text();
    expect(map).not.toContain("labels.chunk");
    // Antarctica lies under the map's southern edge.
    expect(COUNTRY_LABELS.every(([, , latitude]) => latitude > -60)).toBe(true);
  });
});
