/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createDomTestHarness } from "../renderers/dom/test-utils";
import { beginLiveResize } from "./live-resize";
import { LivePaneFrameContext, type CellSize, type LivePaneFrame } from "./live-stretch";
import { nextResizeHold, RESIZE_SETTLE_MS, settleResizeHold, useSettledLayoutSize, type SettledLayoutSize } from "./resize-settle";

const harness = createDomTestHarness({ withUi: false });
const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

describe("nextResizeHold", () => {
  test("holds the layout at the size it had through a resize, lays it out again past a 1.5x stretch, and settles at the last size", () => {
    let state = { size: { width: 80, height: 24 }, held: null as CellSize | null };
    state = nextResizeHold(state, { width: 90, height: 24 });
    expect(state.held).toEqual({ width: 80, height: 24 });
    state = nextResizeHold(state, { width: 110, height: 30 });
    expect(state.held).toEqual({ width: 80, height: 24 });
    // Shrinking past two thirds of the held size: laid out again, still resizing.
    state = nextResizeHold(state, { width: 50, height: 30 });
    expect(state.held).toEqual({ width: 50, height: 30 });
    expect(nextResizeHold(state, { width: 50, height: 30 })).toBe(state);
    expect(settleResizeHold(nextResizeHold(state, { width: 60, height: 31 }))).toEqual({ size: { width: 60, height: 31 }, held: null });
  });
});

describe("useSettledLayoutSize", () => {
  function Probe({ initial, seen, enabled }: { initial: CellSize; seen: { size?: SettledLayoutSize; resize?: (size: CellSize) => void }; enabled?: boolean }) {
    const [size, setSize] = useState(initial);
    seen.resize = setSize;
    seen.size = useSettledLayoutSize(size.width, size.height, { enabled });
    return null;
  }

  test("a run of size changes keeps the first size and settles once, RESIZE_SETTLE_MS after the last", async () => {
    const seen: { size?: SettledLayoutSize; resize?: (size: CellSize) => void } = {};
    await harness.render(<Probe initial={{ width: 80, height: 24 }} seen={seen} />);
    expect(seen.size).toEqual({ width: 80, height: 24, resizing: false });

    for (const width of [82, 85, 88]) {
      await act(async () => seen.resize!({ width, height: 24 }));
      // The render with the new size already holds and says so.
      expect(seen.size).toEqual({ width: 80, height: 24, resizing: true });
      await wait(RESIZE_SETTLE_MS / 2);
    }
    expect(seen.size?.resizing).toBe(true);
    await wait(RESIZE_SETTLE_MS + 40);
    expect(seen.size).toEqual({ width: 88, height: 24, resizing: false });
  });

  test("a resize the pointer still holds settles when it lets go, however long it pauses", async () => {
    const seen: { size?: SettledLayoutSize; resize?: (size: CellSize) => void } = {};
    await harness.render(<Probe initial={{ width: 80, height: 24 }} seen={seen} />);
    const end = beginLiveResize();
    try {
      await act(async () => seen.resize!({ width: 90, height: 26 }));
      await wait(RESIZE_SETTLE_MS * 3);
      expect(seen.size).toEqual({ width: 80, height: 24, resizing: true });
    } finally {
      end();
    }
    await wait(RESIZE_SETTLE_MS + 40);
    expect(seen.size).toEqual({ width: 90, height: 26, resizing: false });
  });

  test("a pane frame under a resize is resizing from its first move, before its content changes size", async () => {
    let live: CellSize | null = null;
    const listeners = new Set<() => void>();
    const frame: LivePaneFrame = {
      rendered: { width: 80, height: 24 },
      live: () => live,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
    const move = (next: CellSize | null) => act(async () => {
      live = next;
      for (const listener of listeners) listener();
    });
    const seen: { size?: SettledLayoutSize; resize?: (size: CellSize) => void } = {};
    await harness.render(
      <LivePaneFrameContext.Provider value={frame}>
        <Probe initial={{ width: 80, height: 24 }} seen={seen} />
      </LivePaneFrameContext.Provider>,
    );
    await move({ width: 84, height: 24 });
    expect(seen.size).toEqual({ width: 80, height: 24, resizing: true });
    await move(null);
    expect(seen.size?.resizing).toBe(false);
  });
});
