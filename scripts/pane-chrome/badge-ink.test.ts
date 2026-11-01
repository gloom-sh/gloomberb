import { expect, test } from "bun:test";
import type { BadgeInkLayout } from "./badge-ink-fixture";
import { Picture, measureChips } from "./badge-ink";

/**
 * A 2x picture painted by hand: a grey chip on a black page, a white icon
 * and white x-height letters inside it whose top and bottom edges fall
 * between pixels. Each pixel takes the share of the shape that covers it,
 * as antialiasing draws an edge.
 */
function picture(shapes: { x: [number, number]; y: [number, number]; rgb: number }[]): Picture {
  const [width, height] = [160, 40];
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (const shape of shapes) {
        const cover = Math.max(0, Math.min(y + 1, shape.y[1]) - Math.max(y, shape.y[0]));
        if (x >= shape.x[0] && x < shape.x[1] && cover > 0) value += (shape.rgb - value) * cover;
      }
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return new Picture(width, height, data);
}

test("ink boxes put an antialiased edge where the shape's edge is, between pixels", () => {
  const layout: BadgeInkLayout = {
    ready: true, viewport: { width: 80, height: 20 }, devicePixelRatio: 2, fontFamily: "test", fontSize: "12px",
    specimens: [{
      id: "mail alex",
      chip: { x: 4, y: 2, width: 60, height: 16 },
      icon: { x: 12, y: 4, width: 12, height: 12 },
      chars: [..."ax"].map((char, index) => ({ char, box: { x: 28 + index * 8, y: 3, width: 8, height: 14 } })),
    }],
  };
  const [chip] = measureChips(picture([
    { x: [8, 128], y: [4, 36], rgb: 80 },
    { x: [26, 46], y: [13.5, 26.5], rgb: 255 },
    { x: [58, 88], y: [14.25, 27.75], rgb: 255 },
  ]), layout);
  expect(chip!.chip.top).toBeCloseTo(4, 2);
  expect(chip!.chip.bottom).toBeCloseTo(36, 2);
  expect(chip!.icon!.top).toBeCloseTo(13.5, 2);
  expect(chip!.icon!.bottom).toBeCloseTo(26.5, 2);
  expect(chip!.xHeight!.top).toBeCloseTo(14.25, 2);
  expect(chip!.xHeight!.bottom).toBeCloseTo(27.75, 2);
  expect(chip!.capitals).toBeNull();
});
