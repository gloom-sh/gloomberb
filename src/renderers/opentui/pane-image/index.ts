import type { CliRenderer } from "@opentui/core";
import { Jimp } from "jimp";
import type { NativeSurfaceManager } from "../../../components/chart/native/surface/manager";
import type { CellRect } from "../../../components/chart/native/chart-rasterizer";
import { intersectCellRects } from "../../../components/chart/native/chart-rasterizer";
import type { NativePaneImage } from "../../../ui/host";
import { frameCellColors, rasterizeFrame, type CellFrame, type FrameCell, type FrameImageLayer } from "./raster";

/** The second cell of a wide character carries these flag bits instead of a character. */
const CHAR_FLAG_MASK = 0xc0000000 | 0;
const CHAR_FLAG_CONTINUATION = 0xc0000000 | 0;

function clipRect(rect: CellRect, width: number, height: number): CellRect | null {
  return intersectCellRects(
    { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    { x: 0, y: 0, width, height },
  );
}

/** The cells of `rect` in the frame the terminal shows now. */
function readFrameCells(renderer: CliRenderer, rect: CellRect): CellFrame | null {
  const buffer = renderer.currentRenderBuffer;
  const area = clipRect(rect, buffer.width, buffer.height);
  if (!area) return null;
  const { char, fg, bg, attributes } = buffer.buffers;
  // Characters (graphemes included) come from the text; the cell arrays say where each sits.
  const lines = new TextDecoder().decode(buffer.getRealCharBytes(true)).split("\n");
  const cells: FrameCell[] = [];
  for (let y = area.y; y < area.y + area.height; y += 1) {
    const lineChars = [...(lines[y] ?? "")];
    let charIndex = 0;
    for (let x = 0; x < area.x + area.width; x += 1) {
      const index = y * buffer.width + x;
      const continuation = ((char[index]! | 0) & CHAR_FLAG_MASK) === CHAR_FLAG_CONTINUATION;
      const text = continuation ? "" : lineChars[charIndex++] ?? " ";
      if (x < area.x) continue;
      cells.push({
        char: text,
        fg: [fg[index * 4]! & 255, fg[index * 4 + 1]! & 255, fg[index * 4 + 2]! & 255, fg[index * 4 + 3]! & 255],
        bg: [bg[index * 4]! & 255, bg[index * 4 + 1]! & 255, bg[index * 4 + 2]! & 255, bg[index * 4 + 3]! & 255],
        attributes: attributes[index]! & 255,
      });
    }
  }
  return { cols: area.width, rows: area.height, cells };
}

/** The kitty images shown inside `rect`, placed relative to it. */
function imageLayers(manager: Pick<NativeSurfaceManager, "visibleImages"> | undefined, rect: CellRect): FrameImageLayer[] {
  if (!manager) return [];
  const layers: FrameImageLayer[] = [];
  for (const image of manager.visibleImages()) {
    const scaleX = image.bitmap.width / Math.max(1, image.rect.width);
    const scaleY = image.bitmap.height / Math.max(1, image.rect.height);
    for (const fragment of image.fragments) {
      const shown = intersectCellRects(fragment, rect);
      if (!shown) continue;
      layers.push({
        x: shown.x - rect.x,
        y: shown.y - rect.y,
        cols: shown.width,
        rows: shown.height,
        bitmap: image.bitmap,
        crop: {
          x: (shown.x - image.rect.x) * scaleX,
          y: (shown.y - image.rect.y) * scaleY,
          width: shown.width * scaleX,
          height: shown.height * scaleY,
        },
      });
    }
  }
  return layers;
}

function hexRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!match) return [0, 0, 0];
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * A PNG of `rect` as the terminal shows it now: the cells drawn in a bundled
 * monospace font, with the kitty charts placed back where they sit.
 */
export async function captureTerminalPaneImage(
  renderer: CliRenderer,
  manager: Pick<NativeSurfaceManager, "visibleImages"> | undefined,
  rect: CellRect,
  background: string,
): Promise<NativePaneImage> {
  const frame = readFrameCells(renderer, rect);
  if (!frame || frame.cols <= 0 || frame.rows <= 0) throw new Error("This pane is not on screen.");
  const base = hexRgb(background);
  const layers = imageLayers(manager, clipRect(rect, renderer.currentRenderBuffer.width, renderer.currentRenderBuffer.height)!);
  const image = rasterizeFrame(frame, layers, base);
  const jimp = new Jimp({ width: image.width, height: image.height, data: Buffer.from(image.pixels.buffer, image.pixels.byteOffset, image.pixels.byteLength) });
  const png = await jimp.getBuffer("image/png");
  return {
    png: new Uint8Array(png),
    width: image.width,
    height: image.height,
    pixels: image.pixels,
    ...(layers.length === 0 ? { cells: { cols: frame.cols, rows: frame.rows, cells: frameCellColors(frame, base) } } : {}),
  };
}
