import { expect, test } from "bun:test";
import { buildSurface3DScene, DEFAULT_SURFACE3D_CAMERA, rotateSurface3DCamera } from "./model";
import { renderSurface3DSoftware } from "./software";

const colors = { bg: "#10151e", grid: "#29323f", axis: "#8190a3", accent: "#79a7df", ridge: "#ffd27a" };
const values = [[0.5, 0.4, 0.3, 0.32, 0.36], [0.42, 0.34, 0.29, 0.3, 0.33], [0.38, 0.31, 0.28, 0.29, 0.31], [0.35, 0.29, 0.26, 0.27, 0.3]];
const scene = buildSurface3DScene({
  values, columnPositions: [0, 0.25, 0.5, 0.75, 1], rowPositions: [0, 1 / 3, 2 / 3, 1], zMin: 0.2, zMax: 0.5,
  xTicks: [{ position: 0.5, label: "ATM" }], yTicks: [{ position: 0, label: "7D" }],
  zTicks: [{ value: 0.3, label: "30%" }], titles: { x: "DELTA", y: "EXPIRY", z: "IMPLIED VOL" },
  ridgeColumn: 2, ridgeLabel: "ATM", selected: { row: 1, column: 2 },
}, 3);

test("the terminal raster draws a coloured, lit, deterministic surface with placed labels", () => {
  const first = renderSurface3DSoftware(scene, 720, 440, colors, DEFAULT_SURFACE3D_CAMERA);
  const again = renderSurface3DSoftware(scene, 720, 440, colors, DEFAULT_SURFACE3D_CAMERA);
  expect(first.bitmap.pixels.length).toBe(720 * 440 * 4);
  expect(Buffer.compare(first.bitmap.pixels, again.bitmap.pixels)).toBe(0);
  const hues = new Set<string>();
  for (let offset = 0; offset < first.bitmap.pixels.length; offset += 4) hues.add(`${first.bitmap.pixels[offset]! >> 4}:${first.bitmap.pixels[offset + 1]! >> 4}:${first.bitmap.pixels[offset + 2]! >> 4}`);
  expect(hues.size).toBeGreaterThan(150);
  expect(first.labels.map((label) => label.text)).toEqual(expect.arrayContaining(["ATM", "DELTA", "EXPIRY", "IMPLIED VOL", "30%"]));
  expect(first.labels.every((label) => label.x >= 0 && label.x < 720 && label.y >= 0 && label.y < 440)).toBe(true);
});

test("draft frames keep size and differ from a rotated view; degenerate sizes stay finite", () => {
  const draft = renderSurface3DSoftware(scene, 720, 440, colors, DEFAULT_SURFACE3D_CAMERA, { quality: "draft" });
  expect(draft.bitmap.width).toBe(720);
  const turned = renderSurface3DSoftware(scene, 720, 440, colors, rotateSurface3DCamera(DEFAULT_SURFACE3D_CAMERA, 0.8, 0), { quality: "draft" });
  expect(Buffer.compare(draft.bitmap.pixels, turned.bitmap.pixels)).not.toBe(0);
  expect(renderSurface3DSoftware(scene, Number.NaN, -10, colors, DEFAULT_SURFACE3D_CAMERA).bitmap).toMatchObject({ width: 1, height: 1 });
});
