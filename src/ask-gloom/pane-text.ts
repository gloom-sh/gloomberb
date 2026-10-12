import type { NativeFrameCapture } from "../ui/host";
import { displayWidth } from "../utils/format";

/**
 * At most this much of a pane's text goes with a question: a summary of what
 * it shows, not a dump. It leaves room in the terminal context Gloom reads,
 * which keeps 2,000 characters of it.
 */
export const PANE_TEXT_MAX_CHARS = 1_500;
const PANE_TEXT_MAX_LINES = 50;

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The frame's sides and rules: lines of them say nothing, and an edge cell is not content. */
const RULE_LINE = /^[\s│┃║┆┊╎─━═┄┈╌┌┐└┘├┤┬┴┼╭╮╯╰▏▕█▐▌░▒▓]*$/u;
const LEADING_EDGE = /^[│┃║▏▕]\s?/u;
const TRAILING_EDGE = /\s?[│┃║▏▕█▐▌░▒▓]+$/u;

/**
 * A pane's text, trimmed to what it says: no frame edges, rules or trailing
 * blanks, runs of padding cut to two spaces so columns stay apart, blank
 * lines folded, and the whole bounded. Null when nothing is left.
 */
export function normalizePaneText(raw: string): string | null {
  const lines: string[] = [];
  let blank = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    if (RULE_LINE.test(rawLine)) {
      blank = lines.length > 0;
      continue;
    }
    const line = rawLine
      .replace(LEADING_EDGE, "")
      .replace(TRAILING_EDGE, "")
      .replace(/\s+$/u, "")
      .replace(/\s{3,}/gu, "  ");
    if (!line.trim()) {
      blank = lines.length > 0;
      continue;
    }
    if (blank) lines.push("");
    blank = false;
    lines.push(line);
  }
  if (lines.length === 0) return null;

  const kept: string[] = [];
  let used = 0;
  for (const line of lines.slice(0, PANE_TEXT_MAX_LINES)) {
    if (used + line.length + 1 > PANE_TEXT_MAX_CHARS) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length === 0) kept.push(lines[0]!.slice(0, PANE_TEXT_MAX_CHARS - 1));
  const cut = kept.length < lines.length || kept[0] !== lines[0];
  return cut ? `${kept.join("\n")}\n…` : kept.join("\n");
}

function covers(rect: CellRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * A terminal pane's text from the frame on screen: the rows under its header,
 * the columns it spans. Cells another surface covers (a floating pane above
 * it, the menu it was asked from) are left blank, so only this pane's own
 * text goes. `rect` and `covered` are in the pane area's cells, which starts
 * `offsetX` columns and `offsetY` rows into the screen (under the app header).
 */
export function terminalPaneText(
  frame: NativeFrameCapture,
  rect: CellRect,
  { offsetX = 0, offsetY = 0, covered = [] }: { offsetX?: number; offsetY?: number; covered?: readonly CellRect[] } = {},
): string | null {
  const rows: string[] = [];
  const left = Math.max(0, Math.floor(rect.x + offsetX));
  const right = Math.floor(rect.x + offsetX + rect.width);
  const top = Math.floor(rect.y) + 1;
  const bottom = Math.floor(rect.y + rect.height);
  for (let row = top; row < bottom; row += 1) {
    const spans = frame.lines[row + offsetY];
    if (!spans) continue;
    let column = 0;
    let text = "";
    for (const span of spans) {
      // One code point per cell; a wide one is followed by an empty continuation cell.
      for (const char of span.text) {
        const start = column;
        const width = displayWidth(char) >= 2 ? 2 : 1;
        column += width;
        if (start < left || start >= right) continue;
        text += covered.some((other) => covers(other, start - offsetX, row)) ? " ".repeat(width) : char;
      }
      if (column >= right) break;
    }
    rows.push(text);
  }
  return normalizePaneText(rows.join("\n"));
}

function attributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

interface PixelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function intersect(a: PixelRect, b: PixelRect): PixelRect | null {
  const rect = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return rect.right > rect.left && rect.bottom > rect.top ? rect : null;
}

/**
 * Where an element's content can be seen: the pane body cut down by every box
 * between them that clips (a scrolled list, a table body), or null when one
 * of them hides it.
 */
function visibleArea(element: Element, body: HTMLElement, cache: Map<Element, PixelRect | null>): PixelRect | null {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  let area: PixelRect | null;
  if (element === body) {
    area = body.getBoundingClientRect();
  } else {
    const parent = element.parentElement;
    area = parent ? visibleArea(parent, body, cache) : null;
    const view = element.ownerDocument.defaultView;
    const style = view?.getComputedStyle(element);
    if (area && style) {
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") area = null;
      else if (style.overflowX !== "visible" || style.overflowY !== "visible") area = intersect(area, element.getBoundingClientRect());
    }
  }
  cache.set(element, area);
  return area;
}

/**
 * A desktop or web pane's text as it is on screen: its body, without the
 * header or footer, and only what can be seen, so rows scrolled out of a list
 * and anything clipped stay out. Text on one line is joined in reading order.
 */
export function domPaneText(paneId: string): string | null {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return null;
  const pane = doc.querySelector<HTMLElement>(`[data-gloom-pane-id="${attributeValue(paneId)}"]`);
  const body = pane?.querySelector<HTMLElement>("[data-gloom-role=pane-body]") ?? pane;
  if (!body) return null;

  const areas = new Map<Element, PixelRect | null>();
  const pieces: Array<{ top: number; bottom: number; left: number; right: number; text: string }> = [];
  const range = doc.createRange();
  const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.replace(/\s+/g, " ").trim();
    const parent = node.parentElement;
    if (!text || !parent) continue;
    const area = visibleArea(parent, body, areas);
    if (!area) continue;
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && intersect(area, rect));
    const first = rects[0];
    if (!first) continue;
    pieces.push({ top: first.top, bottom: first.bottom, left: first.left, right: first.right, text });
  }
  range.detach?.();

  // Pieces whose middles share a line read as one, left to right, with a
  // gap where the pane leaves one between them.
  pieces.sort((a, b) => (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2 || a.left - b.left);
  const lines: Array<{ middle: number; height: number; parts: typeof pieces }> = [];
  for (const piece of pieces) {
    const middle = (piece.top + piece.bottom) / 2;
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.middle - middle) < Math.max(4, line.height / 2)) line.parts.push(piece);
    else lines.push({ middle, height: piece.bottom - piece.top, parts: [piece] });
  }
  const text = lines.map((line) => {
    const parts = [...line.parts].sort((a, b) => a.left - b.left);
    return parts.reduce((out, part, index) => {
      if (index === 0) return part.text;
      const gap = part.left - parts[index - 1]!.right;
      return `${out}${gap > 6 ? "  " : gap > 0.5 ? " " : ""}${part.text}`;
    }, "");
  }).join("\n");
  return normalizePaneText(text);
}
