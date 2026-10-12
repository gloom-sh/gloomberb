import { describe, expect, test } from "bun:test";
import { Jimp } from "jimp";
import { Text } from "../../../ui";
import { createOpenTuiTestHarness } from "../test-utils";
import { captureTerminalPaneImage } from ".";
import { rasterizeFrame, type FrameCell } from "./raster";

const tui = createOpenTuiTestHarness({ width: 20, height: 4 });

const WHITE: FrameCell["fg"] = [255, 255, 255, 255];
const BLACK: FrameCell["bg"] = [0, 0, 0, 255];

function row(text: string): FrameCell[] {
  return [...text].map((char) => ({ char, fg: WHITE, bg: BLACK, attributes: 0 }));
}

function pixel(image: { width: number; pixels: Uint8ClampedArray }, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return [...image.pixels.slice(offset, offset + 3)];
}

describe("a pane's picture in the terminal", () => {
  test("box lines run to the cell edges, so neighbouring cells join", () => {
    const image = rasterizeFrame({ cols: 2, rows: 2, cells: [...row("──"), ...row("│ ")] });
    const cellWidth = image.width / 2;
    const cellHeight = image.height / 2;
    const middle = cellHeight / 2;
    // Across the boundary of the two horizontal cells, and down from the top cell into the vertical one.
    expect(pixel(image, cellWidth - 1, middle)).toEqual([255, 255, 255]);
    expect(pixel(image, cellWidth, middle)).toEqual([255, 255, 255]);
    expect(pixel(image, cellWidth / 2, cellHeight)).toEqual([255, 255, 255]);
    expect(pixel(image, cellWidth / 2, cellHeight - 3)).toEqual([0, 0, 0]);
  });

  test("a kitty chart is drawn back over the blank cells it leaves in the frame", () => {
    const red = new Uint8Array(4 * 4 * 4);
    for (let index = 0; index < red.length; index += 4) red.set([220, 30, 30, 255], index);
    const image = rasterizeFrame({ cols: 3, rows: 1, cells: row("   ") }, [{
      x: 1,
      y: 0,
      cols: 2,
      rows: 1,
      bitmap: { width: 4, height: 4, pixels: red },
      crop: { x: 0, y: 0, width: 4, height: 4 },
    }]);
    const cellWidth = image.width / 3;
    expect(pixel(image, cellWidth / 2, image.height / 2)).toEqual([0, 0, 0]);
    expect(pixel(image, cellWidth * 2, image.height / 2)).toEqual([220, 30, 30]);
  });

  test("takes the cells of its rectangle, wide characters spanning two", async () => {
    await tui.render(<Text>{"ab漢字cd"}</Text>);
    await tui.renderFrames(1);
    const shot = await captureTerminalPaneImage(tui.setup().renderer as never, undefined, { x: 1, y: 0, width: 6, height: 1 }, "#000000");
    expect(shot.cells?.cells.map((cell) => cell.char)).toEqual(["b", "漢", "", "字", "", "c"]);
    const decoded = await Jimp.read(Buffer.from(shot.png));
    expect([decoded.bitmap.width, decoded.bitmap.height]).toEqual([shot.width, shot.height]);
    expect(shot.width / shot.cells!.cols).toBe(shot.height / shot.cells!.rows / 2);
  });
});
