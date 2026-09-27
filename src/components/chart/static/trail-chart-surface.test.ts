import { expect, test } from "bun:test";
import { layoutTrailAxis, layoutTrailOverlay } from "./trail-chart-surface";

const blank = (width: number, height: number) => Array.from({ length: height }, () => " ".repeat(width));
const QUADRANTS = [
  { text: "Improving", tone: "muted", corner: "tl" },
  { text: "Leading", tone: "positive", corner: "tr" },
  { text: "Lagging", tone: "negative", corner: "bl" },
  { text: "Weakening", tone: "warning", corner: "br" },
] as const;

test("head labels sit beside their heads, a cell apart, never on a head", () => {
  // Three heads side by side: the right-hand places run into each other.
  const heads = [
    { id: "a", text: "XLK", x: 10, y: 4, color: "#f00", bold: true },
    { id: "b", text: "XLV", x: 15, y: 4, color: "#0f0" },
    { id: "c", text: "XLE", x: 17, y: 4, color: "#00f" },
  ];
  const { labels } = layoutTrailOverlay({
    marks: blank(40, 9), heads, centerX: 20, centerY: 4, yName: "Momentum", quadrants: QUADRANTS,
  });
  const placed = labels.filter((label) => ["a", "b", "c"].includes(label.id));
  expect(placed.map((label) => label.id).sort()).toEqual(["a", "b", "c"]);
  // The selected head, first, takes the place right of it.
  expect(placed.find((label) => label.id === "a")).toMatchObject({ x: 11, y: 4, bold: true });
  for (const label of placed) {
    for (const head of heads) {
      const onHead = label.y === head.y && head.x >= label.x && head.x < label.x + label.text.length;
      expect(onHead).toBe(false);
      // Touching another head on its row would read as that head's label.
      if (head.id !== label.id && label.y === head.y) {
        expect(head.x === label.x - 1 || head.x === label.x + label.text.length).toBe(false);
      }
    }
    for (const other of placed) {
      if (other === label || other.y !== label.y) continue;
      expect(label.x + label.text.length < other.x || other.x + other.text.length < label.x).toBe(true);
    }
  }
});

test("the crosshair is box lines in the cells the trails leave blank", () => {
  const marks = blank(21, 7);
  // A trail crosses the center row at column 4 and the center column at row 1.
  marks[3] = `${" ".repeat(4)}•${" ".repeat(16)}`;
  marks[1] = `${" ".repeat(10)}•${" ".repeat(10)}`;
  const { lines } = layoutTrailOverlay({
    marks, heads: [], centerX: 10, centerY: 3, yName: "Momentum", quadrants: [],
    anchors: [{ x: 0, y: 3 }, { x: 10, y: 6 }],
  });
  const at = (x: number, y: number) => lines.find((cell) => cell.x === x && cell.y === y)?.char;
  expect(at(10, 3)).toBe("┼");
  expect(at(2, 3)).toBe("─");
  expect(at(10, 5)).toBe("│");
  // The trail keeps its cells.
  expect(at(4, 3)).toBeUndefined();
  expect(at(10, 1)).toBeUndefined();
  // The momentum name tops the vertical line.
  expect(at(10, 0)).toBeUndefined();
  expect(lines.every((cell) => !cell.cursor)).toBe(true);
});

test("the cursor runs through the selected head's column and stands in for a 100 line beside it", () => {
  const cursor = layoutTrailOverlay({
    marks: blank(21, 7), heads: [], centerX: 10, centerY: 3, cursorX: 4, yName: "M", quadrants: [],
  }).lines;
  expect(cursor.filter((cell) => cell.cursor).map((cell) => cell.char)).toEqual(["│", "│", "│", "┼", "│", "│", "│"]);
  expect(cursor.some((cell) => cell.x === 10 && cell.char === "│")).toBe(true);
  const beside = layoutTrailOverlay({
    marks: blank(21, 7), heads: [], centerX: 10, centerY: 3, cursorX: 11, yName: "M", quadrants: [],
    anchors: [{ x: 10, y: 6 }],
  }).lines;
  expect(beside.some((cell) => cell.x === 10 && cell.char === "│")).toBe(false);
  expect(beside.find((cell) => cell.x === 10 && cell.y === 3)?.char).toBe("─");
  // The anchor that kept 100 in the middle is erased rather than left as a dot.
  expect(beside.find((cell) => cell.x === 10 && cell.y === 6)?.char).toBe(" ");
});

test("quadrant names take the corners only where no trail runs", () => {
  const marks = blank(30, 9);
  marks[0] = `${" ".repeat(24)}••••••`;
  marks[1] = `${" ".repeat(24)}••••••`;
  const { labels } = layoutTrailOverlay({
    marks, heads: [], centerX: 15, centerY: 4, yName: "Momentum", quadrants: QUADRANTS,
  });
  const ids = labels.map((label) => label.id);
  expect(ids).toContain("quadrant-tl");
  expect(ids).not.toContain("quadrant-tr");
  expect(labels.find((label) => label.id === "quadrant-br")).toMatchObject({ x: 20, y: 8 });
});

test("the strength axis keeps the cursor's reading and its name before the ticks", () => {
  const items = layoutTrailAxis({
    width: 40,
    ticks: [{ label: "90", x: 4 }, { label: "95", x: 12 }, { label: "100", x: 20 }, { label: "105", x: 28 }, { label: "110", x: 36 }],
    name: "Strength →",
    readout: { label: "96.63", x: 14 },
  });
  expect(items.map((item) => item.text)).toEqual(["96.63", "Strength →", "90", "100"]);
  expect(items.find((item) => item.kind === "name")!.left).toBe(30);
  // Nothing touches its neighbour.
  const spans = items.map((item) => [item.left, item.left + item.text.length] as const).sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < spans.length; index += 1) expect(spans[index]![0]).toBeGreaterThan(spans[index - 1]![1]);
});
