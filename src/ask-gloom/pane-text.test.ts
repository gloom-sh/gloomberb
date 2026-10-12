import { describe, expect, test } from "bun:test";
import type { NativeFrameCapture } from "../ui/host";
import { normalizePaneText, PANE_TEXT_MAX_CHARS, terminalPaneText } from "./pane-text";

const WHITE = [255, 255, 255, 255] as const;

/** A frame whose rows are these strings, one span each, the way the renderer reports cells. */
function frame(rows: string[]): NativeFrameCapture {
  return {
    cols: 40,
    rows: rows.length,
    // A wide character's second cell is an empty continuation, so it is one code point here.
    lines: rows.map((row) => [{ text: row, fg: WHITE, bg: WHITE, attributes: 0 }]),
  };
}

describe("terminalPaneText", () => {
  test("reads the pane's own cells under its header, leaving out what covers it", () => {
    const screen = frame([
      "app header row                          ",
      "┌─:: PF ──────────┐ :: Other ──────────",
      "│ AAPL   212.10   │ left alone          ",
      "│ MSFT   ┌─:: Floating over it ─┐      ",
      "│ NVDA   │ private text         │      ",
      "└────────┴──────────────────────┘      ",
    ]);
    const text = terminalPaneText(screen, { x: 0, y: 0, width: 19, height: 5 }, {
      offsetY: 1,
      covered: [{ x: 7, y: 2, width: 24, height: 3 }],
    });
    expect(text).toBe("AAPL  212.10\nMSFT\nNVDA");
    expect(text).not.toContain("private");
    expect(text).not.toContain("left alone");
  });

  test("counts a wide character as two cells when it finds the pane's columns", () => {
    const screen = frame([
      "header",
      "中文 AB | next",
    ]);
    // Columns 0-6: two wide characters (4 cells), a space, A, B.
    expect(terminalPaneText(screen, { x: 0, y: 0, width: 7, height: 2 }, { offsetY: 0 })).toBe("中文 AB");
    expect(terminalPaneText(screen, { x: 5, y: 0, width: 2, height: 2 }, { offsetY: 0 })).toBe("AB");
  });
});

describe("normalizePaneText", () => {
  test("keeps a long pane to a bounded summary that says it was cut", () => {
    const rows = Array.from({ length: 400 }, (_, index) => `Row ${index}        value ${index * 3}`);
    const text = normalizePaneText(rows.join("\n"))!;
    expect(text.length).toBeLessThanOrEqual(PANE_TEXT_MAX_CHARS + 2);
    expect(text.endsWith("\n…")).toBe(true);
    // Padding between columns is cut to two spaces, so a column still reads as one.
    expect(text.split("\n")[0]).toBe("Row 0  value 0");
  });

  test("has nothing to say for a pane of rules and blanks", () => {
    expect(normalizePaneText("────\n   \n│   │")).toBeNull();
  });
});
