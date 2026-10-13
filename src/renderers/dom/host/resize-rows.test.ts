import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { beginLiveResize } from "../../../ui/live-resize";
import { attachResizeRows, RESIZE_HELD_ATTRIBUTE, type ResizeRows } from "./resize-rows";

/** A list of stacked 10px rows, 300px wide, showing 40px at a time: just the DOM the hold reads and writes. */
class FakeList {
  scrollTop = 0;
  readonly clientHeight = 40;
  readonly children: FakeRow[];

  constructor(count: number) {
    this.children = Array.from({ length: count }, (_, index) => new FakeRow(this, index));
  }

  getBoundingClientRect() {
    return { top: 0, bottom: this.clientHeight, height: this.clientHeight, width: 300 };
  }

  held(): number[] {
    return this.children.filter((row) => row.attributes.has(RESIZE_HELD_ATTRIBUTE)).map((row) => row.index);
  }
}

class FakeRow {
  readonly attributes = new Set<string>();
  readonly properties = new Map<string, string>();
  readonly style = {
    setProperty: (name: string, value: string) => { this.properties.set(name, value); },
    removeProperty: (name: string) => { this.properties.delete(name); },
  };

  constructor(private readonly list: FakeList, readonly index: number) {}

  getBoundingClientRect() {
    const top = this.index * 10 - this.list.scrollTop;
    return { top, bottom: top + 10, height: 10, width: 300 };
  }

  setAttribute(name: string) { this.attributes.add(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index);

let frames: Array<() => void> = [];
const globals = globalThis as unknown as Record<string, unknown>;
const saved = { requestAnimationFrame: globals.requestAnimationFrame, cancelAnimationFrame: globals.cancelAnimationFrame };
let rows: ResizeRows | null = null;
let endResize: (() => void) | null = null;

beforeEach(() => {
  frames = [];
  globals.requestAnimationFrame = (callback: () => void) => frames.push(callback);
  globals.cancelAnimationFrame = (id: number) => { frames[id - 1] = () => {}; };
});

afterEach(() => {
  endResize?.();
  endResize = null;
  rows?.dispose();
  rows = null;
  globals.requestAnimationFrame = saved.requestAnimationFrame;
  globals.cancelAnimationFrame = saved.cancelAnimationFrame;
});

function nextFrame() {
  const due = frames;
  frames = [];
  for (const callback of due) callback();
}

describe("rows through a live resize", () => {
  test("rows away from the view keep their width until the resize ends, and the rows in and near it follow", () => {
    const list = new FakeList(40);
    list.scrollTop = 200; // Rows 20 to 23 in view; a quarter of the view past it either way is near.
    rows = attachResizeRows(list as unknown as HTMLElement);

    endResize = beginLiveResize();
    expect(list.held()).toEqual([...range(0, 19), ...range(25, 40)]);
    expect(list.children[0]!.properties.get("--gloom-resize-held-width")).toBe("300px");

    endResize();
    endResize = null;
    expect(list.held()).toEqual([]);
    expect(list.children[0]!.properties.size).toBe(0);
  });

  test("a held row that comes near the view follows again from the next frame", () => {
    const list = new FakeList(40);
    list.scrollTop = 200;
    rows = attachResizeRows(list as unknown as HTMLElement);
    endResize = beginLiveResize();

    // Rows above re-wrap and the list keeps its bottom: rows 16 to 19 come into view.
    list.scrollTop = 160;
    rows.update();
    expect(list.held()).toContain(16);

    nextFrame();
    expect(list.held()).toEqual([...range(0, 15), ...range(25, 40)]);
  });
});
