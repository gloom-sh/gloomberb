import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { WORLD_MAP_DATA_SPECIFIER } from "../../../renderers/dom/build-assets";
import { basemapLevel, basemapPaths, decodeParts, DETAIL_MIN_PX_PER_DEGREE, tilesInView, type DetailTile } from "./basemap";
import { DETAIL_TILES } from "./natural-earth/index.chunk";
import * as world from "./natural-earth/world-50m.chunk";

/** The generator's polyline encoding, for hand-made chunks. */
function encode(parts: [number, number][][]): string {
  const value = (delta: number) => {
    let bits = delta < 0 ? ~(delta << 1) : delta << 1;
    let text = "";
    while (bits >= 0x20) {
      text += String.fromCharCode((0x20 | (bits & 0x1f)) + 63);
      bits >>= 5;
    }
    return text + String.fromCharCode(bits + 63);
  };
  return parts.map((points) => {
    let lon = 0;
    let lat = 0;
    return points.map(([x, y]) => {
      const text = value(x - lon) + value(y - lat);
      lon = x;
      lat = y;
      return text;
    }).join("");
  }).join(" ");
}

describe("basemap", () => {
  test("decodes negative, large and repeated coordinates exactly", () => {
    const parts: [number, number][][] = [[[-179_999, -60_000], [179_999, 89_999], [179_999, 89_999], [0, 1], [-1, 0]], [[12, -34]]];
    expect(decodeParts(encode(parts)).map((run) => [...run])).toEqual(parts.map((points) => points.flat()));
  });

  test("the 1:50m chunk stays on the map: every point inside 180°W to 180°E and 60°S to 90°N", () => {
    const rings = decodeParts(world.LAND);
    expect(rings.length).toBeGreaterThan(1000);
    for (const ring of rings) {
      for (let index = 0; index < ring.length; index += 2) {
        expect(Math.abs(ring[index]! * world.STEP)).toBeLessThanOrEqual(180);
        expect(ring[index + 1]! * world.STEP).toBeGreaterThanOrEqual(-60);
      }
    }
  });

  test("a tile's coastline leaves out the edges its own cut made, so tiles meet without a seam line", () => {
    // Land filling the tile's west half: its west, north and south sides are cuts, only the east side is coast.
    const chunk = { STEP: 1, LAND: encode([[[0, 0], [5, 0], [5, 10], [0, 10]]]), BORDERS: "" };
    const paths = basemapPaths(chunk, [0, 0, 10, 10]);
    expect(paths.land).toBe("M0 0L5 0L5 -10L0 -10Z");
    expect(paths.coast).toBe("M5 0L5 -10");
  });

  test("detail loads only the tiles under the view, with a margin for the next pan", () => {
    const ids = (view: [number, number, number, number]) => tilesInView(DETAIL_TILES, view).map((tile) => tile.id).sort();
    // The Strait of Hormuz, about four degrees across, sits in one tile.
    expect(ids([54.5, 25, 58.5, 27.6])).toEqual(["e045n15"]);
    // The Suez Canal straddles 30°N, so it needs the tile above too.
    expect(ids([31, 28.5, 34, 31.5])).toEqual(["e030n15", "e030n30"]);
    const fake = (id: string, box: [number, number, number, number]): DetailTile => ({ id, box, load: async () => ({ STEP: 1, LAND: "", BORDERS: "" }) });
    const tiles = [fake("west", [-15, 0, 0, 15]), fake("east", [0, 0, 15, 15]), fake("far", [30, 0, 45, 15])];
    expect(tilesInView(tiles, [1, 1, 10, 10], 0).map((tile) => tile.id)).toEqual(["east"]);
    expect(tilesInView(tiles, [1, 1, 10, 10], 0.15).map((tile) => tile.id)).toEqual(["west", "east"]);
  });

  test("1:10m takes over once a degree is wide enough on screen", () => {
    expect(basemapLevel(DETAIL_MIN_PX_PER_DEGREE - 0.1)).toBe("world");
    expect(basemapLevel(DETAIL_MIN_PX_PER_DEGREE)).toBe("detail");
  });

  test("the view build's data specifier points at the generated index beside the map", () => {
    const source = join(dirname(import.meta.path), WORLD_MAP_DATA_SPECIFIER.replace(/\.js$/, ".ts"));
    expect(existsSync(source)).toBe(true);
  });

  test("the terminal's bundle of the map carries none of the land data", () => {
    // In its own process: the bundler run inside the test runner resolves modules unreliably.
    const result = Bun.spawnSync(
      [process.execPath, "build", "--target=bun", "--packages=external", "--minify", join(dirname(import.meta.path), "map.tsx")],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const code = result.stdout.toString();
    expect(code.length).toBeGreaterThan(10_000);
    // A run of the encoded coastline the bundler writes as it is, with nothing to escape.
    const sample = /[A-Za-z0-9@?_^|~{}]{32}/.exec(world.LAND)![0];
    expect(code).not.toContain(sample);
  });
});
