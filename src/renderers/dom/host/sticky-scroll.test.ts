import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachStickyScroll } from "./sticky-scroll";

/** A scroller of stacked rows with a layout of its own: just enough of the DOM for the logic that reads it. */
class FakeScroller {
  scrollTop = 0;
  clientHeight = 100;
  readonly heights: number[];
  readonly children: FakeRow[];
  readonly scrollListeners = new Set<() => void>();

  constructor(heights: number[]) {
    this.heights = heights;
    this.children = heights.map((_, index) => new FakeRow(this, index));
  }

  get scrollHeight() {
    return this.heights.reduce((sum, height) => sum + height, 0);
  }

  getBoundingClientRect() {
    return { top: 0, bottom: this.clientHeight, height: this.clientHeight };
  }

  addEventListener(type: string, listener: () => void) {
    if (type === "scroll") this.scrollListeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void) {
    if (type === "scroll") this.scrollListeners.delete(listener);
  }

  /** The reader scrolls: the position changes and the browser announces it. */
  scrollBy(delta: number) {
    this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + delta));
    for (const listener of this.scrollListeners) listener();
  }

  /** A row changes height, as content does when an image loads or an edit lands. */
  resize(index: number, height: number) {
    this.heights[index] = height;
    // The browser keeps the offset when content changes, unless it now overshoots.
    this.scrollTop = Math.min(this.scrollTop, Math.max(0, this.scrollHeight - this.clientHeight));
    observers.resize?.([sizeEntry(this.children[index]!, height)]);
  }

  /** The scrollport changes height: the observer reports the scroller itself. */
  resizeView(height: number) {
    this.clientHeight = height;
    observers.resize?.([sizeEntry(this, height)]);
  }

  prepend(height: number) {
    this.heights.unshift(height);
    this.children.unshift(new FakeRow(this, -1));
    this.children.forEach((child, index) => { child.index = index; });
    observers.mutation?.();
  }

  append(height: number) {
    this.heights.push(height);
    this.children.push(new FakeRow(this, this.heights.length - 1));
    observers.mutation?.();
  }

  /** Where a row sits, as `top` of its client rect. */
  top(index: number) {
    return this.heights.slice(0, index).reduce((sum, height) => sum + height, 0) - this.scrollTop;
  }
}

class FakeRow {
  constructor(private readonly scroller: FakeScroller, public index: number) {}

  get parentElement() {
    return this.scroller;
  }

  getBoundingClientRect() {
    const top = this.scroller.top(this.index);
    const height = this.scroller.heights[this.index]!;
    return { top, bottom: top + height, height };
  }
}

/** What a ResizeObserver reports for one element: only the height is read. */
function sizeEntry(target: object, height: number) {
  return { target, contentRect: { height }, borderBoxSize: [{ blockSize: height, inlineSize: 0 }] };
}

const observers: { resize?: (entries: unknown[]) => void; mutation?: () => void } = {};
const globals = globalThis as unknown as Record<string, unknown>;
const saved = { ResizeObserver: globals.ResizeObserver, MutationObserver: globals.MutationObserver };

beforeEach(() => {
  observers.resize = undefined;
  observers.mutation = undefined;
  globals.ResizeObserver = class {
    constructor(callback: (entries: unknown[]) => void) { observers.resize = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globals.MutationObserver = class {
    constructor(callback: () => void) { observers.mutation = callback; }
    observe() {}
    disconnect() {}
  };
});

const attached: Array<{ dispose(): void }> = [];

afterEach(() => {
  // A scroller left attached would still answer the next suite's live resizes.
  for (const sticky of attached.splice(0)) sticky.dispose();
  globals.ResizeObserver = saved.ResizeObserver;
  globals.MutationObserver = saved.MutationObserver;
});

function attach(scroller: FakeScroller, options: { startAtBottom?: boolean; onPinChange?: (pinned: boolean) => void } = {}) {
  const sticky = attachStickyScroll(scroller as unknown as HTMLElement, { startAtBottom: options.startAtBottom ?? true, onPinChange: options.onPinChange });
  attached.push(sticky);
  return sticky;
}

describe("a sticky scroller", () => {
  test("opens at the bottom of what is there and follows rows added while the reader is at it", () => {
    const scroller = new FakeScroller(Array(20).fill(10));
    attach(scroller);
    expect(scroller.scrollTop).toBe(100);

    scroller.append(30);
    expect(scroller.scrollTop).toBe(130);
  });

  test("leaves a reader who scrolled back where they are as rows arrive below", () => {
    const scroller = new FakeScroller(Array(20).fill(10));
    attach(scroller);
    scroller.scrollBy(-60);

    scroller.append(30);
    scroller.append(30);
    expect(scroller.scrollTop).toBe(40);
  });

  test("follows from a few pixels short of the bottom, and reports leaving and reaching it", () => {
    const pins: boolean[] = [];
    const scroller = new FakeScroller(Array(20).fill(10));
    attach(scroller, { onPinChange: (pinned) => pins.push(pinned) });

    scroller.scrollBy(-3);
    scroller.append(20);
    expect(scroller.scrollTop).toBe(120);
    expect(pins).toEqual([]);

    scroller.scrollBy(-50);
    scroller.scrollBy(50);
    expect(pins).toEqual([false, true]);
  });

  test("a scroll event with no new position is the scrollport changing size, not the reader leaving the bottom", () => {
    const pins: boolean[] = [];
    const scroller = new FakeScroller(Array(20).fill(10));
    attach(scroller, { onPinChange: (pinned) => pins.push(pinned) });

    // The viewport shrinks by 20px; the browser reports a scroll although the offset stayed.
    scroller.clientHeight = 80;
    for (const listener of scroller.scrollListeners) listener();
    scroller.resizeView(80);

    expect(pins).toEqual([]);
    expect(scroller.scrollTop).toBe(120);
  });

  test("keeps the first row in view where it is when rows are added above it, or one above it changes", () => {
    const scroller = new FakeScroller(Array(20).fill(10));
    attach(scroller);
    scroller.scrollBy(-55);
    // Row 4 is the first with any part in view: it starts 5px above the top.
    expect(scroller.top(4)).toBe(-5);

    scroller.prepend(70);
    expect(scroller.top(5)).toBe(-5);

    scroller.resize(0, 25);
    expect(scroller.top(5)).toBe(-5);
  });

  test("does not undo a scroll the browser has not announced yet when a row arrives", () => {
    const scroller = new FakeScroller(Array(20).fill(10));
    attach(scroller);
    scroller.scrollBy(-40);

    // The reader scrolls again in the same frame the row lands, before the scroll event is delivered.
    scroller.scrollTop -= 20;
    scroller.append(10);
    expect(scroller.scrollTop).toBe(40);
  });
});
