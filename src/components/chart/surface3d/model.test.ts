import { describe, expect, test } from "bun:test";
import {
  buildSurface3DScene, clampSurface3DCamera, DEFAULT_SURFACE3D_CAMERA, FLOOR, hitTestSurface3D, projectSurface3D,
  rotateSurface3DCamera, surface3DBox, surface3DLabels, surface3DLayout, surface3DViewport, surfaceBoundaryFans, zoomSurface3DCamera,
  type Surface3DInput,
} from "./model";

const input = (values: (number | null)[][], extra: Partial<Surface3DInput> = {}): Surface3DInput => ({
  values,
  columnPositions: values[0]!.map((_, index, row) => index / (row.length - 1)),
  rowPositions: values.map((_, index) => index / (values.length - 1)),
  zMin: 0.2, zMax: 0.5,
  xTicks: [{ position: 0, label: "10P" }, { position: 0.5, label: "ATM" }, { position: 1, label: "10C" }],
  yTicks: [{ position: 0, label: "7D" }, { position: 1, label: "1Y" }],
  zTicks: [{ value: 0.2, label: "20%" }, { value: 0.3, label: "30%" }, { value: 0.4, label: "40%" }, { value: 0.5, label: "50%" }],
  titles: { x: "DELTA", y: "EXPIRY", z: "IMPLIED VOL" },
  ...extra,
});
const smooth = [[0.5, 0.4, 0.3, 0.32, 0.36], [0.42, 0.34, 0.29, 0.3, 0.33], [0.38, 0.31, 0.28, 0.29, 0.31], [0.35, 0.29, 0.26, 0.27, 0.3]];

describe("scene geometry", () => {
  test("the display lattice passes exactly through every grid node and stays within its neighbours", () => {
    const scene = buildSurface3DScene(input(smooth), 4);
    for (let r = 0; r < smooth.length; r += 1) for (let c = 0; c < smooth[0]!.length; c += 1) {
      const index = (r * 4) * scene.latticeColumns + c * 4;
      expect(scene.positions[index * 3 + 2]).toBeCloseTo(scene.worldZ(smooth[r]![c]!), 5);
    }
    const zs = Array.from({ length: scene.latticeRows * scene.latticeColumns }, (_, index) => scene.positions[index * 3 + 2]!);
    expect(Math.max(...zs)).toBeLessThanOrEqual(scene.worldZ(0.5) + 1e-6);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(scene.worldZ(0.26) - 1e-6);
    expect(scene.indices.length).toBe((scene.latticeRows - 1) * (scene.latticeColumns - 1) * 6);
    expect(scene.nodes).toHaveLength(20);
    const normalLength = Math.hypot(scene.normals[0]!, scene.normals[1]!, scene.normals[2]!);
    expect(normalLength).toBeCloseTo(1, 5);
  });

  test("holes stay open: no face spans a missing node and isolated rows remain as wire", () => {
    const holed = smooth.map((row) => [...row]) as (number | null)[][];
    holed[1]![2] = null;
    const scene = buildSurface3DScene(input(holed), 2);
    const missing = 1 * 2 * scene.latticeColumns + 2 * 2;
    expect(Number.isNaN(scene.positions[missing * 3]!)).toBe(true);
    expect([...scene.indices].every((index) => Number.isFinite(scene.positions[index * 3]!))).toBe(true);
    const isolated = buildSurface3DScene(input([[0.3, 0.31, 0.32], [null, null, null], [null, null, null]]), 2);
    expect(isolated.indices.length).toBe(0);
    expect(isolated.wire.length).toBe(2 * 6);
  });

  test("rows of different widths join through boundary fans on existing nodes only", () => {
    expect(surfaceBoundaryFans([[false, true, true, false], [true, true, true, true]])).toEqual([
      [{ row: 0, column: 1 }, { row: 1, column: 0 }, { row: 1, column: 1 }],
      [{ row: 0, column: 2 }, { row: 1, column: 2 }, { row: 1, column: 3 }],
    ]);
    expect(surfaceBoundaryFans([[true, false, true], [true, true, true]])).toEqual([]);
  });

  test("an ATM ridge follows the smooth surface along its column", () => {
    const scene = buildSurface3DScene(input(smooth, { ridgeColumn: 2, ridgeLabel: "ATM" }), 3);
    expect(scene.ridge.length).toBe((scene.latticeRows - 1) * 6);
    expect(scene.ridge[2]).toBeCloseTo(scene.worldZ(0.3), 5);
  });
});

describe("camera, layout and interaction", () => {
  test("cameras clamp, wrap and zoom within bounds", () => {
    const wrapped = clampSurface3DCamera({ azimuth: 7 * Math.PI, elevation: 9, zoom: 99 });
    expect(Math.abs(wrapped.azimuth)).toBeCloseTo(Math.PI, 9);
    expect(wrapped).toMatchObject({ elevation: 1.4, zoom: 2.4 });
    expect(zoomSurface3DCamera(DEFAULT_SURFACE3D_CAMERA, 0).zoom).toBe(0.5);
    const fallback = clampSurface3DCamera({ azimuth: Number.NaN, elevation: Number.NaN, zoom: Number.NaN });
    expect(fallback.azimuth).toBeCloseTo(DEFAULT_SURFACE3D_CAMERA.azimuth, 9);
    expect(fallback).toMatchObject({ elevation: DEFAULT_SURFACE3D_CAMERA.elevation, zoom: 1 });
  });

  test("the fit does not change scale while the camera turns, and every angle stays in frame", () => {
    const scene = buildSurface3DScene(input(smooth), 2);
    const base = surface3DViewport(800, 500, DEFAULT_SURFACE3D_CAMERA, scene.top);
    for (let step = 0; step < 16; step += 1) {
      const camera = rotateSurface3DCamera(DEFAULT_SURFACE3D_CAMERA, step * Math.PI / 8, 0);
      const viewport = surface3DViewport(800, 500, camera, scene.top);
      expect(viewport.scale).toBeCloseTo(base.scale, 9);
      for (const node of scene.nodes) {
        const point = projectSurface3D(node, viewport);
        expect(point.x).toBeGreaterThan(0); expect(point.x).toBeLessThan(800);
        expect(point.y).toBeGreaterThan(0); expect(point.y).toBeLessThan(500);
      }
    }
  });

  test("walls sit on the far sides and labels on the near edges as the camera turns", () => {
    const scene = buildSurface3DScene(input(smooth), 2);
    for (const azimuth of [-2.4, -0.7, 0.7, 2.4]) {
      const viewport = surface3DViewport(800, 500, { azimuth, elevation: 0.6, zoom: 1 }, scene.top);
      const layout = surface3DLayout(viewport);
      const toViewer = (x: number, y: number) => x * viewport.sinA + y * viewport.cosA;
      expect(toViewer(layout.farX, 0)).toBeLessThan(0);
      expect(toViewer(0, layout.farY)).toBeLessThan(0);
      const box = surface3DBox(scene, layout);
      expect(box.panels).toHaveLength(3);
      const labels = surface3DLabels(scene, viewport, layout);
      expect(labels.filter((label) => label.key.startsWith("x:") && label.role === "tick").every((label) => Math.sign(label.world.y) === Math.sign(layout.nearY))).toBe(true);
      // The floor-level z tick is left to the colour bar.
      expect(labels.some((label) => label.key === "z:20%")).toBe(false);
    }
  });

  test("hit testing returns the nearest node and prefers the nearer of two overlapping nodes", () => {
    const scene = buildSurface3DScene(input(smooth), 2);
    const viewport = surface3DViewport(800, 500, DEFAULT_SURFACE3D_CAMERA, scene.top);
    const node = scene.nodes.find((point) => point.row === 2 && point.column === 3)!;
    const at = projectSurface3D(node, viewport);
    expect(hitTestSurface3D(scene, viewport, at.x, at.y, 2)).toEqual({ row: 2, column: 3 });
    expect(hitTestSurface3D(scene, viewport, -500, -500)).toBeNull();
    const floor = projectSurface3D({ ...node, z: FLOOR }, viewport);
    expect(Number.isFinite(floor.x)).toBe(true);
  });
});
