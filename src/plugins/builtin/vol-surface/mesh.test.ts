import { expect, test } from "bun:test";
import { buildSurfaceMesh, surfaceMeshBoundary, type SurfaceMeshFace } from "./mesh";

function area(faces: SurfaceMeshFace[]): number {
  return faces.reduce((sum, face) => sum + Math.abs(face.vertices.reduce((value, a, index) => {
    const b = face.vertices[(index + 1) % face.vertices.length]!;
    return value + a.column * b.row - b.column * a.row;
  }, 0)) / 2, 0);
}

test("tapered expiry boundaries form a complete supported strip without inventing grid vertices", () => {
  const available = [[false, false, true, true, true, false, false], [true, true, true, true, true, true, true]];
  const faces = buildSurfaceMesh(available);
  expect(faces.filter((face) => face.vertices.length === 4)).toHaveLength(2);
  expect(faces.filter((face) => face.vertices.length === 3)).toHaveLength(4);
  expect(area(faces)).toBe(4); // Trapezoid with supported widths 2 and 6, height 1.
  expect(faces.flatMap((face) => face.vertices).every(({ row, column }) => available[row]![column])).toBe(true);
  const edges = surfaceMeshBoundary(faces);
  expect(edges.has("0:2/1:0")).toBe(true);
  expect(edges.has("0:4/1:6")).toBe(true);
  expect(edges.has("0:2/1:2")).toBe(false);
  expect(area(buildSurfaceMesh([...available].reverse()))).toBe(4);
});

test("internal support holes, disjoint rows and missing tenors cannot acquire boundary triangles", () => {
  const hole = [[true, true, false, true, true], [true, true, true, true, true]];
  const faces = buildSurfaceMesh(hole);
  expect(area(faces)).toBe(2);
  expect(faces.every((face) => face.vertices.length === 4)).toBe(true);
  expect(buildSurfaceMesh([[true, true, false, false], [false, false, true, true]])).toEqual([]);
  expect(buildSurfaceMesh([[true, true, true], [false, false, false], [true, true, true]])).toEqual([]);
  expect(buildSurfaceMesh([[false, true, false], [true, true, true]])).toEqual([]);
});

test("opposing support shifts triangulate each wing once and retain a coherent outer boundary", () => {
  const faces = buildSurfaceMesh([[true, true, true, true, false, false], [false, true, true, true, true, true]]);
  expect(area(faces)).toBe(3.5);
  expect(surfaceMeshBoundary(faces).size).toBe(9); // 3 top + 4 bottom edges + two sloped sides.
  expect(faces.flatMap((face) => face.vertices).some(({ row, column }) => row === 0 && column > 3 || row === 1 && column < 1)).toBe(false);
});
