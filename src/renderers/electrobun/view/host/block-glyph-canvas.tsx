/** @jsxImportSource react */
import { memo, useEffect, useRef, type CSSProperties } from "react";

/**
 * Quadrant coverage for the 2x2 block glyphs the ascii fonts are built from,
 * as [top-left, top-right, bottom-left, bottom-right]. Fonts on Windows and
 * Linux either lack these glyphs or fall back to a face with other metrics,
 * so drawing the cells directly is the only way the wordmark looks the same
 * everywhere.
 */
const QUADRANTS: Record<string, readonly [boolean, boolean, boolean, boolean]> = {
  " ": [false, false, false, false],
  "▘": [true, false, false, false],
  "▝": [false, true, false, false],
  "▖": [false, false, true, false],
  "▗": [false, false, false, true],
  "▀": [true, true, false, false],
  "▄": [false, false, true, true],
  "▌": [true, false, true, false],
  "▐": [false, true, false, true],
  "▞": [false, true, true, false],
  "▚": [true, false, false, true],
  "▛": [true, true, true, false],
  "▜": [true, true, false, true],
  "▙": [true, false, true, true],
  "▟": [false, true, true, true],
  "█": [true, true, true, true],
};

export function blockGlyphPath(
  lines: readonly string[],
  cellWidth: number,
  cellHeight: number,
): Path2D {
  const path = new Path2D();
  const halfWidth = cellWidth / 2;
  const halfHeight = cellHeight / 2;
  lines.forEach((line, row) => {
    let column = 0;
    for (const character of line) {
      const quadrants = QUADRANTS[character];
      if (quadrants) {
        const x = column * cellWidth;
        const y = row * cellHeight;
        if (quadrants[0]) path.rect(x, y, halfWidth, halfHeight);
        if (quadrants[1]) path.rect(x + halfWidth, y, halfWidth, halfHeight);
        if (quadrants[2]) path.rect(x, y + halfHeight, halfWidth, halfHeight);
        if (quadrants[3]) path.rect(x + halfWidth, y + halfHeight, halfWidth, halfHeight);
      }
      column += 1;
    }
  });
  return path;
}

export const BlockGlyphCanvas = memo(function BlockGlyphCanvas({
  lines,
  color,
  cellWidth,
  cellHeight,
  style,
}: {
  lines: readonly string[];
  color?: string;
  cellWidth: number;
  cellHeight: number;
  style?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const columns = Math.max(0, ...lines.map((line) => [...line].length));
  const width = columns * cellWidth;
  const height = lines.length * cellHeight;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const scale = Math.max(1, Math.min(globalThis.devicePixelRatio || 1, 3));
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    // The computed color resolves theme variables the canvas cannot parse.
    context.fillStyle = getComputedStyle(canvas).color;
    // One path for every cell: a union has no anti-aliased seams between
    // neighbouring quadrants, separate fills would.
    context.fill(blockGlyphPath(lines, cellWidth, cellHeight));
  }, [cellHeight, cellWidth, color, height, lines, width]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{ display: "block", width, height, color, ...style }}
    />
  );
});
