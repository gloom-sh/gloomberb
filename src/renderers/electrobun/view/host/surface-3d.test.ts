import { describe, expect, test } from "bun:test";
import { canMorphSurface, morphSurfaceGeometry, type SurfaceGeometry } from "./surface-3d";

function geometry(z: number, indices = [0, 1, 2]): SurfaceGeometry {
  return {
    positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: Float32Array.from([z, 0, 0, z, 0, 0, z, 0, 0]),
    wire: Float32Array.from([0, 0, z, 1, 0, z]),
    ridge: new Float32Array(0),
    drop: new Float32Array(0),
    indices: Uint32Array.from(indices),
  };
}

describe("surface morph", () => {
  test("morphs a refresh of the same mesh, swaps a different one", () => {
    expect(canMorphSurface(geometry(0.2), geometry(0.3))).toBe(true);
    // A cell that gained or lost a quote changes the triangles.
    expect(canMorphSurface(geometry(0.2), geometry(0.3, [0, 2, 1]))).toBe(false);
    // Nothing moved (for example only the selection changed).
    expect(canMorphSurface(geometry(0.2), geometry(0.2))).toBe(false);
  });

  test("eases from the shown shape to the new one", () => {
    const out = geometry(0);
    morphSurfaceGeometry(out, geometry(0), geometry(1), 0.5);
    expect(out.positions[2]).toBeCloseTo(0.875);
    morphSurfaceGeometry(out, geometry(0), geometry(1), 1);
    expect(out.positions[2]).toBe(1);
    expect(out.wire[5]).toBe(1);
  });
});
