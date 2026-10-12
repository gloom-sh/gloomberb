import { inflateRawSync } from "zlib";
import glyphData from "./glyphs.json";

/** One cell of a captured terminal frame. Colours are 0-255 RGBA. */
export interface FrameCell {
  /** The cell's text; empty for the second cell of a wide character. */
  char: string;
  fg: readonly [number, number, number, number];
  bg: readonly [number, number, number, number];
  attributes: number;
}

export interface CellFrame {
  cols: number;
  rows: number;
  /** Row-major, `cols * rows` cells. */
  cells: FrameCell[];
}

/** An image the terminal drew over the cells (a kitty chart), placed in cell units. */
export interface FrameImageLayer {
  x: number;
  y: number;
  cols: number;
  rows: number;
  bitmap: { width: number; height: number; pixels: Uint8Array };
  /** The part of the bitmap shown in those cells, in bitmap pixels. */
  crop: { x: number; y: number; width: number; height: number };
}

export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

const BOLD = 1 << 0;
const DIM = 1 << 1;
const UNDERLINE = 1 << 3;
const INVERSE = 1 << 5;
const HIDDEN = 1 << 6;
const STRIKETHROUGH = 1 << 7;

interface GlyphAtlas {
  cellWidth: number;
  cellHeight: number;
  /** Code point to the offset (in coverage values) of its bitmap. */
  regular: Map<number, number>;
  bold: Map<number, number>;
  wide: Map<number, number>;
  /** 0-15 coverage per pixel. */
  coverage: Uint8Array;
}

let atlas: GlyphAtlas | null = null;

function loadAtlas(): GlyphAtlas {
  if (atlas) return atlas;
  const { cellWidth, cellHeight } = glyphData;
  const packed = inflateRawSync(Buffer.from(glyphData.coverage, "base64"));
  const coverage = new Uint8Array(packed.length * 2);
  for (let index = 0; index < packed.length; index += 1) {
    coverage[index * 2] = packed[index]! >> 4;
    coverage[index * 2 + 1] = packed[index]! & 15;
  }
  const narrowSize = cellWidth * cellHeight;
  let offset = 0;
  const index = (text: string, size: number) => {
    const map = new Map<number, number>();
    for (const char of text) {
      map.set(char.codePointAt(0)!, offset);
      offset += size;
    }
    return map;
  };
  const regular = index(glyphData.narrow, narrowSize);
  const bold = index(glyphData.bold, narrowSize);
  const wide = index(glyphData.wide, narrowSize * 2);
  atlas = { cellWidth, cellHeight, regular, bold, wide, coverage };
  return atlas;
}

/**
 * Up, right, down, left arm weights of U+2500 to U+257F: 0 none, 1 light,
 * 2 heavy, 3 double; `.` for arcs and diagonals, drawn on their own.
 */
const BOX_ARMS = "0101020210102020010102021010202001010202101020200110021001200220"
  + "0011001200210022110012002100220010011002200120021110121021101120"
  + "2120221012202220101110122011102120212012102220220111011202110212"
  + "0121012202210222110111021201120221012102220122021111111212111212"
  + "2111112121212112221111221221221212222122222122220101020210102020"
  + "0303303003100130033000130031003313003100330010033001300313103130"
  + "3330101330313033031301310333130331013303131331313333............"
  + "................000110000100001000022000020000200201102001022010";

function dashed(codePoint: number): boolean {
  return (codePoint >= 0x2504 && codePoint <= 0x250b) || (codePoint >= 0x254c && codePoint <= 0x254f);
}

type Paint = (x: number, y: number, alpha: number) => void;

function fillRect(paint: Paint, x0: number, y0: number, x1: number, y1: number, alpha = 1): void {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.ceil(y1); y += 1) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.ceil(x1); x += 1) paint(x, y, alpha);
  }
}

/** Lines meet in the middle of the cell, so neighbouring cells join without a gap. */
function drawBox(paint: Paint, codePoint: number, width: number, height: number): void {
  const arms = BOX_ARMS.slice((codePoint - 0x2500) * 4, (codePoint - 0x2500) * 4 + 4);
  const light = Math.max(1, Math.round(width / 6));
  const heavy = light * 2;
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  if (arms === "....") {
    drawArcOrDiagonal(paint, codePoint, width, height, light);
    return;
  }
  const [up, right, down, left] = [...arms].map(Number) as [number, number, number, number];
  const thickness = (weight: number) => (weight === 2 ? heavy : light);
  const horizontalExtent = Math.max(up, down) === 3 ? light * 1.5 + light / 2 : thickness(Math.max(up, down)) / 2;
  const verticalExtent = Math.max(left, right) === 3 ? light * 1.5 + light / 2 : thickness(Math.max(left, right)) / 2;
  const segment = (fromX: number, fromY: number, toX: number, toY: number) => {
    if (!dashed(codePoint)) {
      fillRect(paint, fromX, fromY, toX, toY);
      return;
    }
    // Dashes: the line in a few pieces with gaps, the way a font draws them.
    const horizontal = toX - fromX > toY - fromY;
    const length = horizontal ? toX - fromX : toY - fromY;
    const pieces = 3;
    const step = length / pieces;
    for (let piece = 0; piece < pieces; piece += 1) {
      const start = (horizontal ? fromX : fromY) + piece * step;
      const end = start + step * 0.6;
      if (horizontal) fillRect(paint, start, fromY, end, toY);
      else fillRect(paint, fromX, start, toX, end);
    }
  };
  const horizontal = (weight: number, fromX: number, toX: number) => {
    if (weight === 3) {
      segment(fromX, cy - light * 1.5, toX, cy - light / 2);
      segment(fromX, cy + light / 2, toX, cy + light * 1.5);
    } else if (weight > 0) {
      const half = thickness(weight) / 2;
      segment(fromX, cy - half, toX, cy + half);
    }
  };
  const vertical = (weight: number, fromY: number, toY: number) => {
    if (weight === 3) {
      segment(cx - light * 1.5, fromY, cx - light / 2, toY);
      segment(cx + light / 2, fromY, cx + light * 1.5, toY);
    } else if (weight > 0) {
      const half = thickness(weight) / 2;
      segment(cx - half, fromY, cx + half, toY);
    }
  };
  horizontal(left, 0, cx + (left ? horizontalExtent : 0));
  horizontal(right, cx - (right ? horizontalExtent : 0), width);
  vertical(up, 0, cy + (up ? verticalExtent : 0));
  vertical(down, cy - (down ? verticalExtent : 0), height);
}

function drawArcOrDiagonal(paint: Paint, codePoint: number, width: number, height: number, stroke: number): void {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  if (codePoint >= 0x2571) {
    // Each diagonal as where it starts and ends across the cell, top to bottom.
    const lines: Array<[number, number]> = [];
    if (codePoint !== 0x2572) lines.push([width, 0]);
    if (codePoint !== 0x2571) lines.push([0, width]);
    for (const [x0, x1] of lines) {
      for (let y = 0; y < height; y += 1) {
        const t = (y + 0.5) / height;
        const x = x0 + (x1 - x0) * t;
        fillRect(paint, x - stroke / 2, y, x + stroke / 2, y + 1);
      }
    }
    return;
  }
  // Rounded corners: a quarter circle into the cell centre, straight to the edges.
  const radius = Math.min(cx, cy);
  const goesRight = codePoint === 0x256d || codePoint === 0x2570;
  const goesDown = codePoint === 0x256d || codePoint === 0x256e;
  const centerX = goesRight ? cx + radius : cx - radius;
  const centerY = goesDown ? cy + radius : cy - radius;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inQuadrant = (goesRight ? x <= centerX : x >= centerX) && (goesDown ? y <= centerY : y >= centerY);
      if (!inQuadrant) continue;
      const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
      const alpha = Math.max(0, Math.min(1, stroke / 2 + 0.5 - Math.abs(distance - radius)));
      if (alpha > 0) paint(x, y, alpha);
    }
  }
  const half = stroke / 2;
  if (goesRight) fillRect(paint, centerX, cy - half, width, cy + half);
  else fillRect(paint, 0, cy - half, centerX, cy + half);
  if (goesDown) fillRect(paint, cx - half, centerY, cx + half, height);
  else fillRect(paint, cx - half, 0, cx + half, centerY);
}

const QUADRANTS: Record<number, number> = {
  // Bits: 1 upper left, 2 upper right, 4 lower left, 8 lower right.
  0x2596: 4, 0x2597: 8, 0x2598: 1, 0x2599: 1 | 4 | 8, 0x259a: 1 | 8,
  0x259b: 1 | 2 | 4, 0x259c: 1 | 2 | 8, 0x259d: 2, 0x259e: 2 | 4, 0x259f: 2 | 4 | 8,
};

function drawBlock(paint: Paint, codePoint: number, width: number, height: number): void {
  if (codePoint === 0x2580) return fillRect(paint, 0, 0, width, height / 2);
  if (codePoint >= 0x2581 && codePoint <= 0x2588) {
    const eighths = codePoint - 0x2580;
    return fillRect(paint, 0, height - (height * eighths) / 8, width, height);
  }
  if (codePoint >= 0x2589 && codePoint <= 0x258f) {
    const eighths = 0x2590 - codePoint;
    return fillRect(paint, 0, 0, (width * eighths) / 8, height);
  }
  if (codePoint === 0x2590) return fillRect(paint, width / 2, 0, width, height);
  if (codePoint >= 0x2591 && codePoint <= 0x2593) return fillRect(paint, 0, 0, width, height, (codePoint - 0x2590) / 4);
  if (codePoint === 0x2594) return fillRect(paint, 0, 0, width, height / 8);
  if (codePoint === 0x2595) return fillRect(paint, width - width / 8, 0, width, height);
  const quadrants = QUADRANTS[codePoint] ?? 0;
  if (quadrants & 1) fillRect(paint, 0, 0, width / 2, height / 2);
  if (quadrants & 2) fillRect(paint, width / 2, 0, width, height / 2);
  if (quadrants & 4) fillRect(paint, 0, height / 2, width / 2, height);
  if (quadrants & 8) fillRect(paint, width / 2, height / 2, width, height);
}

/** Braille dots: bits 0-2 the left column, 3-5 the right, 6 and 7 the bottom row. */
const BRAILLE_DOTS: Array<[number, number]> = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]];

function drawBraille(paint: Paint, codePoint: number, width: number, height: number): void {
  const bits = codePoint - 0x2800;
  const dot = Math.max(2, Math.round(width / 4));
  for (let bit = 0; bit < 8; bit += 1) {
    if (!(bits & (1 << bit))) continue;
    const [column, row] = BRAILLE_DOTS[bit]!;
    const x = ((column * 2 + 1) * width) / 4;
    const y = ((row * 2 + 1) * height) / 8;
    fillRect(paint, x - dot / 2, y - dot / 2, x + dot / 2, y + dot / 2);
  }
}

function drawnByRenderer(codePoint: number): boolean {
  return (codePoint >= 0x2500 && codePoint <= 0x259f) || (codePoint >= 0x2800 && codePoint <= 0x28ff);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function cellColors(cell: FrameCell, background: readonly [number, number, number]): {
  fg: [number, number, number];
  bg: [number, number, number];
} {
  const over = (color: readonly [number, number, number, number]): [number, number, number] => {
    const alpha = color[3] / 255;
    return [mix(background[0], color[0], alpha), mix(background[1], color[1], alpha), mix(background[2], color[2], alpha)];
  };
  let bg = over(cell.bg);
  let fg = over(cell.fg);
  if (cell.attributes & INVERSE) [fg, bg] = [bg, fg];
  if (cell.attributes & DIM) fg = [mix(bg[0], fg[0], 0.6), mix(bg[1], fg[1], 0.6), mix(bg[2], fg[2], 0.6)];
  if (cell.attributes & HIDDEN) fg = bg;
  return { fg, bg };
}

function hexColor([r, g, b]: readonly [number, number, number]): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** The frame's cells in the colours they show, for a preview drawn in cells. */
export function frameCellColors(
  frame: CellFrame,
  background: readonly [number, number, number] = [0, 0, 0],
): Array<{ char: string; fg: string; bg: string; bold: boolean }> {
  return frame.cells.map((cell) => {
    const { fg, bg } = cellColors(cell, background);
    return { char: cell.char, fg: hexColor(fg), bg: hexColor(bg), bold: (cell.attributes & BOLD) !== 0 };
  });
}

/**
 * Draws a captured frame as pixels: each cell's background, its character
 * from the glyph atlas (box drawing, blocks and braille drawn exactly so
 * borders and charts join), then any images the terminal drew over the cells.
 */
export function rasterizeFrame(
  frame: CellFrame,
  layers: readonly FrameImageLayer[] = [],
  background: readonly [number, number, number] = [0, 0, 0],
): RgbaImage {
  const glyphs = loadAtlas();
  const cellWidth = glyphs.cellWidth;
  const cellHeight = glyphs.cellHeight;
  const width = frame.cols * cellWidth;
  const height = frame.rows * cellHeight;
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let row = 0; row < frame.rows; row += 1) {
    for (let col = 0; col < frame.cols; col += 1) {
      const cell = frame.cells[row * frame.cols + col];
      if (!cell) continue;
      const { bg } = cellColors(cell, background);
      const originX = col * cellWidth;
      const originY = row * cellHeight;
      for (let y = 0; y < cellHeight; y += 1) {
        let offset = ((originY + y) * width + originX) * 4;
        for (let x = 0; x < cellWidth; x += 1) {
          pixels[offset] = bg[0];
          pixels[offset + 1] = bg[1];
          pixels[offset + 2] = bg[2];
          pixels[offset + 3] = 255;
          offset += 4;
        }
      }
    }
  }

  const paintAt = (originX: number, originY: number, spanWidth: number, fg: [number, number, number]): Paint => (x, y, alpha) => {
    if (x < 0 || y < 0 || x >= spanWidth || y >= cellHeight || alpha <= 0) return;
    const offset = ((originY + y) * width + originX + x) * 4;
    pixels[offset] = mix(pixels[offset]!, fg[0], alpha);
    pixels[offset + 1] = mix(pixels[offset + 1]!, fg[1], alpha);
    pixels[offset + 2] = mix(pixels[offset + 2]!, fg[2], alpha);
  };

  for (let row = 0; row < frame.rows; row += 1) {
    for (let col = 0; col < frame.cols; col += 1) {
      const cell = frame.cells[row * frame.cols + col];
      if (!cell || !cell.char) continue;
      const codePoint = cell.char.codePointAt(0) ?? 32;
      const { fg, bg } = cellColors(cell, background);
      if (fg[0] === bg[0] && fg[1] === bg[1] && fg[2] === bg[2]) continue;
      const next = col + 1 < frame.cols ? frame.cells[row * frame.cols + col + 1] : undefined;
      const cells = next && next.char === "" ? 2 : 1;
      const spanWidth = cellWidth * cells;
      const paint = paintAt(col * cellWidth, row * cellHeight, spanWidth, fg);

      if (codePoint !== 32) {
        if (drawnByRenderer(codePoint)) {
          if (codePoint <= 0x257f) drawBox(paint, codePoint, cellWidth, cellHeight);
          else if (codePoint <= 0x259f) drawBlock(paint, codePoint, cellWidth, cellHeight);
          else drawBraille(paint, codePoint, cellWidth, cellHeight);
        } else {
          const bold = (cell.attributes & BOLD) !== 0;
          const boldOffset = bold ? glyphs.bold.get(codePoint) : undefined;
          const wideOffset = glyphs.wide.get(codePoint);
          const offset = boldOffset ?? glyphs.regular.get(codePoint) ?? wideOffset;
          if (offset === undefined) {
            // A character the atlas lacks: a hollow box, as a terminal shows one.
            const inset = Math.round(cellWidth / 6);
            const box = spanWidth - inset * 2;
            fillRect(paint, inset, cellHeight * 0.25, inset + box, cellHeight * 0.25 + 1);
            fillRect(paint, inset, cellHeight * 0.8 - 1, inset + box, cellHeight * 0.8);
            fillRect(paint, inset, cellHeight * 0.25, inset + 1, cellHeight * 0.8);
            fillRect(paint, inset + box - 1, cellHeight * 0.25, inset + box, cellHeight * 0.8);
          } else {
            const glyphWidth = offset === wideOffset ? cellWidth * 2 : cellWidth;
            const shift = Math.floor((spanWidth - glyphWidth) / 2);
            // Bold without a bold glyph is the regular one drawn twice, a pixel apart.
            const smear = bold && boldOffset === undefined ? 1 : 0;
            for (let y = 0; y < cellHeight; y += 1) {
              for (let x = 0; x < glyphWidth; x += 1) {
                let coverage = glyphs.coverage[offset + y * glyphWidth + x]!;
                if (smear && x > 0) coverage = Math.max(coverage, glyphs.coverage[offset + y * glyphWidth + x - 1]!);
                if (coverage) paint(x + shift, y, coverage / 15);
              }
            }
          }
        }
      }
      if (cell.attributes & UNDERLINE) fillRect(paint, 0, cellHeight - 3, spanWidth, cellHeight - 1);
      if (cell.attributes & STRIKETHROUGH) fillRect(paint, 0, cellHeight / 2, spanWidth, cellHeight / 2 + 1);
    }
  }

  for (const layer of layers) drawLayer(pixels, width, height, layer, cellWidth, cellHeight);
  return { width, height, pixels };
}

/** Scales the shown part of an image into its cells, bilinear, over what is drawn. */
function drawLayer(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  layer: FrameImageLayer,
  cellWidth: number,
  cellHeight: number,
): void {
  const { bitmap, crop } = layer;
  if (crop.width <= 0 || crop.height <= 0 || bitmap.width <= 0 || bitmap.height <= 0) return;
  const destX = layer.x * cellWidth;
  const destY = layer.y * cellHeight;
  const destWidth = layer.cols * cellWidth;
  const destHeight = layer.rows * cellHeight;
  const sample = (sx: number, sy: number, channel: number) => {
    const x = Math.max(0, Math.min(bitmap.width - 1, sx));
    const y = Math.max(0, Math.min(bitmap.height - 1, sy));
    return bitmap.pixels[(y * bitmap.width + x) * 4 + channel]!;
  };
  for (let y = 0; y < destHeight; y += 1) {
    const py = destY + y;
    if (py < 0 || py >= height) continue;
    const sy = crop.y + ((y + 0.5) * crop.height) / destHeight - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < destWidth; x += 1) {
      const px = destX + x;
      if (px < 0 || px >= width) continue;
      const sx = crop.x + ((x + 0.5) * crop.width) / destWidth - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const channel = (index: number) => mix(
        mix(sample(x0, y0, index), sample(x0 + 1, y0, index), fx),
        mix(sample(x0, y0 + 1, index), sample(x0 + 1, y0 + 1, index), fx),
        fy,
      );
      const alpha = channel(3) / 255;
      if (alpha <= 0) continue;
      const offset = (py * width + px) * 4;
      pixels[offset] = mix(pixels[offset]!, channel(0), alpha);
      pixels[offset + 1] = mix(pixels[offset + 1]!, channel(1), alpha);
      pixels[offset + 2] = mix(pixels[offset + 2]!, channel(2), alpha);
    }
  }
}
