import { describe, expect, test } from "bun:test";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import {
  DEFAULT_SURFACE_CAMERA, clampSurfaceCamera, hitTestSurface, projectSurfacePoint,
  renderVolatilitySurface, rotateSurfaceCamera, zoomSurfaceCamera, type VolatilitySurfaceGrid,
} from "./raster";

const palette = resolveChartPalette({ bg: "#10151e", border: "#29323f", borderFocused: "#79a7df",
  text: "#e9eef4", textDim: "#8190a3", positive: "#6acaba", negative: "#e4837c" });
const grid: VolatilitySurfaceGrid = {
  tenors: [7 / 365, 30 / 365, 90 / 365, 1],
  moneyness: [0.8, 0.9, 1, 1.1, 1.2],
  volatilities: [[0.5, 0.4, 0.3, 0.32, 0.36], [0.42, 0.34, 0.29, 0.3, 0.33],
    [0.38, 0.31, 0.28, 0.29, 0.31], [0.35, 0.29, 0.26, 0.27, 0.3]],
};

describe("surface geometry and interaction", () => {
  test("camera rotation, zoom and extreme persisted settings produce finite perspective coordinates", () => {
    const origin = projectSurfacePoint({ x: 0.8, y: 0.6, z: 0.4 }, 800, 500, DEFAULT_SURFACE_CAMERA);
    const rotated = projectSurfacePoint({ x: 0.8, y: 0.6, z: 0.4 }, 800, 500,
      rotateSurfaceCamera(DEFAULT_SURFACE_CAMERA, 0.6, 0.2));
    expect(Math.hypot(origin.x - rotated.x, origin.y - rotated.y)).toBeGreaterThan(10);
    const camera = clampSurfaceCamera({ azimuth: 300 * Math.PI, elevation: 10, zoom: Infinity });
    expect(Math.abs(camera.azimuth)).toBeLessThan(1e-10);
    expect(camera.elevation).toBeLessThan(Math.PI / 2);
    expect(camera.zoom).toBe(1);
    expect(zoomSurfaceCamera(DEFAULT_SURFACE_CAMERA, 1e6).zoom).toBe(1.75);
    expect(zoomSurfaceCamera(DEFAULT_SURFACE_CAMERA, 0).zoom).toBe(0.55);
    for (let angle = -Math.PI; angle < Math.PI; angle += 0.4) {
      const scene = renderVolatilitySurface(grid, 640, 400, palette, { azimuth: angle, elevation: 0.8, zoom: 1 });
      expect(scene.projectedCells.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.depth))).toBe(true);
      expect(scene.projectedCells.every((point) => point.x > 0 && point.x < 640 && point.y > 0 && point.y < 400)).toBe(true);
    }
  });

  test("clicks follow reprojected cells after rotation and respect a maximum hit radius", () => {
    const camera = rotateSurfaceCamera(DEFAULT_SURFACE_CAMERA, 1.1, -0.2);
    const scene = renderVolatilitySurface(grid, 800, 500, palette, camera);
    const target = scene.projectedCells.find((cell) => cell.tenorIndex === 2 && cell.moneynessIndex === 3)!;
    expect(hitTestSurface(scene, target.x, target.y, 2)).toEqual({ tenorIndex: 2, moneynessIndex: 3 });
    expect(hitTestSurface(scene, -200, -200)).toBeNull();
    const overlap = { ...scene, projectedCells: [
      { ...target, tenorIndex: 0, depth: -1 }, { ...target, tenorIndex: 1, depth: 1 },
    ] };
    expect(hitTestSurface(overlap, target.x, target.y)).toEqual({ tenorIndex: 1, moneynessIndex: 3 });
  });
});

describe("software raster", () => {
  test("paints deterministic opaque shaded faces, axis geometry and an independently visible selection", () => {
    const original = structuredClone(grid);
    const scene = renderVolatilitySurface(grid, 720, 440, palette);
    expect(scene.faceCount).toBe(12);
    expect(scene.projectedCells).toHaveLength(20);
    expect(scene.bitmap.pixels.length).toBe(720 * 440 * 4);
    let colored = 0;
    const rgb = new Set<number>();
    for (let offset = 0; offset < scene.bitmap.pixels.length; offset += 4) {
      const r = scene.bitmap.pixels[offset]!, g = scene.bitmap.pixels[offset + 1]!, b = scene.bitmap.pixels[offset + 2]!;
      if (r !== 16 || g !== 21 || b !== 30) colored += 1;
      rgb.add(r * 65536 + g * 256 + b);
      if (scene.bitmap.pixels[offset + 3] !== 255) throw new Error("Bitmap contains a transparent pixel");
    }
    expect(colored).toBeGreaterThan(20_000);
    expect(rgb.size).toBeGreaterThan(500);
    const again = renderVolatilitySurface(grid, 720, 440, palette);
    expect(Buffer.compare(scene.bitmap.pixels, again.bitmap.pixels)).toBe(0);
    const selected = renderVolatilitySurface(grid, 720, 440, palette, DEFAULT_SURFACE_CAMERA,
      { tenorIndex: 1, moneynessIndex: 2 });
    expect(Buffer.compare(scene.bitmap.pixels, selected.bitmap.pixels)).not.toBe(0);
    expect(selected.faceCount).toBe(scene.faceCount);
    expect(selected.projectedCells).toEqual(scene.projectedCells);
    expect(grid).toEqual(original);
  });

  test("missing cells remove every incident quad without bridging an unavailable tenor", () => {
    const missing = { ...grid, volatilities: grid.volatilities.map((row, index) => index === 1 ? row.map(() => null) : [...row]) };
    const scene = renderVolatilitySurface(missing, 500, 320, palette);
    expect(scene.faceCount).toBe(4);
    expect(scene.projectedCells).toHaveLength(15);
    expect(scene.projectedCells.some((point) => point.tenorIndex === 1)).toBe(false);
    const hole = { ...grid, volatilities: grid.volatilities.map((row) => [...row]) };
    hole.volatilities[1]![2] = null;
    expect(renderVolatilitySurface(hole, 500, 320, palette).faceCount).toBe(8);
  });

  test("flat smiles, single expiries and malformed cells remain finite and never fabricate a surface", () => {
    const single: VolatilitySurfaceGrid = { tenors: [0.1], moneyness: [0.8, 1, 1.2], volatilities: [[0.3, 0.3, 0.3]] };
    const scene = renderVolatilitySurface(single, 500, 320, palette);
    expect(scene.faceCount).toBe(0);
    expect(scene.projectedCells).toHaveLength(3);
    expect(scene.projectedCells.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    const empty = renderVolatilitySurface({ tenors: [NaN, 0.1], moneyness: [1], volatilities: [[0.3], [Infinity]] }, 100, 80, palette);
    expect(empty.faceCount).toBe(0);
    expect(empty.projectedCells).toEqual([]);
    expect(empty.labels).toEqual([]);
    expect(renderVolatilitySurface(grid, NaN, -10, palette).bitmap).toMatchObject({ width: 1, height: 1 });
  });
});
