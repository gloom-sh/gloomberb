import { expect, test } from "bun:test";
import { terminalFrameScreenshot } from "./screenshot";

test("terminal frames become hex-coloured spans the server accepts", () => {
  const shot = terminalFrameScreenshot({
    cols: 3,
    rows: 1,
    lines: [[
      { text: "AB", fg: [255, 128, 0, 255], bg: [0, 0, 0, 0], attributes: 0 },
      { text: "C", fg: [1, 2, 3, 255], bg: [10, 20, 30, 255], attributes: 1 | (7 << 8) },
    ]],
  });
  expect(shot).toEqual({
    kind: "terminal",
    cols: 3,
    rows: 1,
    lines: [[
      { t: "AB", fg: "#ff8000", bg: "#00000000" },
      { t: "C", fg: "#010203", bg: "#0a141e", a: 1 },
    ]],
  });
});
