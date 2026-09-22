export interface SurfaceMeshVertex { row: number; column: number }
export interface SurfaceMeshFace { vertices: SurfaceMeshVertex[] }

/**
 * Join adjacent expiry rows inside their contiguous observed support. Complete
 * cells remain quads. At the outer boundary a triangle fan joins the wider row
 * to the narrower row's endpoint, using only existing supported vertices.
 * Internal gaps and wholly unavailable expiries are never spanned.
 */
export function buildSurfaceMesh(available: readonly (readonly boolean[])[]): SurfaceMeshFace[] {
  const faces: SurfaceMeshFace[] = [];
  const vertex = (row: number, column: number): SurfaceMeshVertex => ({ row, column });
  const contiguous = (row: readonly boolean[]) => {
    const first = row.indexOf(true), last = row.lastIndexOf(true);
    return first < 0 || row.slice(first, last + 1).some((value) => !value) ? null : { first, last };
  };
  for (let row = 0; row < available.length - 1; row += 1) {
    const upper = available[row]!, lower = available[row + 1]!;
    for (let column = 0; column < Math.min(upper.length, lower.length) - 1; column += 1) {
      if (upper[column] && upper[column + 1] && lower[column] && lower[column + 1]) {
        faces.push({ vertices: [vertex(row, column), vertex(row, column + 1), vertex(row + 1, column + 1), vertex(row + 1, column)] });
      }
    }
    const a = contiguous(upper), b = contiguous(lower);
    // A single shared column is insufficient to establish an intervening strip.
    if (!a || !b || Math.max(a.first, b.first) >= Math.min(a.last, b.last)) continue;
    const fan = (tipRow: number, tipColumn: number, edgeRow: number, from: number, to: number) => {
      for (let column = from; column < to; column += 1) faces.push({
        vertices: [vertex(tipRow, tipColumn), vertex(edgeRow, column), vertex(edgeRow, column + 1)],
      });
    };
    if (a.first > b.first) fan(row, a.first, row + 1, b.first, a.first);
    else if (b.first > a.first) fan(row + 1, b.first, row, a.first, b.first);
    if (a.last < b.last) fan(row, a.last, row + 1, a.last, b.last);
    else if (b.last < a.last) fan(row + 1, b.last, row, b.last, a.last);
  }
  return faces;
}

export function surfaceMeshEdgeKey(a: SurfaceMeshVertex, b: SurfaceMeshVertex): string {
  const first = `${a.row}:${a.column}`, second = `${b.row}:${b.column}`;
  return first < second ? `${first}/${second}` : `${second}/${first}`;
}

/** Count incident faces so outlines follow actual support, including holes. */
export function surfaceMeshBoundary(faces: readonly SurfaceMeshFace[]): Set<string> {
  const counts = new Map<string, number>();
  for (const face of faces) for (let index = 0; index < face.vertices.length; index += 1) {
    const key = surfaceMeshEdgeKey(face.vertices[index]!, face.vertices[(index + 1) % face.vertices.length]!);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([key]) => key));
}
