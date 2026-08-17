import { describe, expect, test } from "bun:test";
import { renderQrLines, renderQrSvgDataUri } from "./qr";

// "test" fits a version 1 QR (21 modules); plus the 4-module quiet zone on
// each side that is 29 columns and ceil(29 / 2) = 15 half-block lines.
const SMALL_INPUT = "test";
const SMALL_SIZE = 21 + 8;

describe("renderQrLines", () => {
  test("produces a square code with two module rows per line", () => {
    const lines = renderQrLines(SMALL_INPUT);
    expect(lines).toHaveLength(Math.ceil(SMALL_SIZE / 2));
    for (const line of lines) {
      expect(line).toHaveLength(SMALL_SIZE);
      expect(line).toMatch(/^[ \u2580\u2584\u2588]+$/);
    }
  });

  test("includes the 4-module quiet zone on every side", () => {
    const lines = renderQrLines(SMALL_INPUT);
    // 4 quiet rows = the first 2 lines; the bottom edge also pads the odd row.
    expect(lines[0]).toBe(" ".repeat(SMALL_SIZE));
    expect(lines[1]).toBe(" ".repeat(SMALL_SIZE));
    expect(lines[13]).toBe(" ".repeat(SMALL_SIZE));
    expect(lines[14]).toBe(" ".repeat(SMALL_SIZE));
    for (const line of lines) {
      expect(line.startsWith("    ")).toBe(true);
      expect(line.endsWith("    ")).toBe(true);
    }
  });

  test("pads the dangling bottom row light when the height is odd", () => {
    // 29 rows means the last line only has a top half; it must never show a
    // bottom-half or full block, or the code gains a phantom module row.
    const lastDataLine = renderQrLines(SMALL_INPUT)[12]!;
    expect(lastDataLine).toMatch(/^[ \u2580]+$/);
  });

  test("merges dark runs into rects that cover exactly the dark modules", () => {
    const svg = decodeURIComponent(
      renderQrSvgDataUri(SMALL_INPUT).slice('url("data:image/svg+xml,'.length, -2),
    );
    expect(svg).toContain(`viewBox="0 0 ${SMALL_SIZE} ${SMALL_SIZE}"`);

    // The half-block lines carry the same grid, so counting dark halves there is
    // an independent check that run merging did not drop or widen a module.
    const darkModules = renderQrLines(SMALL_INPUT)
      .join("")
      .split("")
      .reduce((total, char) => total + (char === "\u2588" ? 2 : char === " " ? 0 : 1), 0);
    const darkArea = [...svg.matchAll(/<rect x="\d+" y="\d+" width="(\d+)" height="1"\/>/g)]
      .reduce((total, match) => total + Number(match[1]), 0);
    expect(darkArea).toBe(darkModules);
  });

  test("renders a verification URI to known stable output", () => {
    expect(renderQrLines("https://gloom.sh/link/TEST-CODE")).toEqual([
      "                                     ",
      "                                     ",
      "    █▀▀▀▀▀█  ▄▀▀█ ▀ ▄▄▄ ▄ █▀▀▀▀▀█    ",
      "    █ ███ █  ▄███▄▀▀▄██▀▀ █ ███ █    ",
      "    █ ▀▀▀ █ ▄▄ ▀█  ▄▄ █▄▀ █ ▀▀▀ █    ",
      "    ▀▀▀▀▀▀▀ ▀ ▀ ▀▄▀▄█▄█▄▀ ▀▀▀▀▀▀▀    ",
      "    ▀▄▄█ ▀▀▄▀█ ▀ ▄▀▄██▄▀▄█▄▀ ▄  ▄    ",
      "    ▀▀▄ ▄ ▀█▄▀▄  █▀▀▄▀█▀▀▀▀█▄▀██     ",
      "     █▀██▄▀  ▄ ▀█▄██▄▄▄██▄▀  ▀ ▀▀    ",
      "    ▀▀█▀▄█▀▄ ▀█▄█▀▀▄ █ ▄▀█▄ ▄█▀█▀    ",
      "      ██ ▄▀█▀▄ ███▄▄▄█▀ ▀▀▄▄ ▄ ▀▄    ",
      "    ▀ █ ▀ ▀▀▀▀▄█▄ █▀▀▄▄ █ ▀ █  ██    ",
      "    ▀   ▀ ▀ ▄ █ ▀ ▄█▀█ ██▀▀▀█ █▄▄    ",
      "    █▀▀▀▀▀█ ▄█ █▀ ▄▄█▀█ █ ▀ █▄▄▀▄    ",
      "    █ ███ █ ▄▀ ▄▄  ▄▀  ▄█▀███▄▄▀▄    ",
      "    █ ▀▀▀ █   █▄▀▄█▄█▄▄██▄▄ █▀▀▄▀    ",
      "    ▀▀▀▀▀▀▀ ▀▀  ▀      ▀▀  ▀▀▀ ▀     ",
      "                                     ",
      "                                     ",
    ]);
  });
});
