/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { act, Profiler, useRef } from "react";
import { createDomTestHarness } from "../renderers/dom/test-utils";
import type { BoxRenderable } from "./host";
import { beginLiveResize, createCatchUp } from "./live-resize";
import { useMeasuredCells } from "./measured-cells";

const harness = createDomTestHarness({ withUi: false });

/** A box whose size the test reports, as the browser's ResizeObserver would. */
function fakeBox() {
  let listener: ((size: { width: number; height: number }) => void) | null = null;
  const box: BoxRenderable = {
    observeSize: (next) => {
      listener = next;
      return () => { listener = null; };
    },
  };
  return { box, measure: (width: number, height: number) => listener?.({ width, height }) };
}

function Measured({ box, shown }: { box: BoxRenderable; shown: { size?: { width: number; height: number } } }) {
  const ref = useRef(box);
  shown.size = useMeasuredCells(ref, { width: 10, height: 5 });
  return null;
}

const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

describe("useMeasuredCells", () => {
  test("renders a measure at once at rest; during a resize, every box's in the next catch-up's one commit, and the last on release", async () => {
    const first = fakeBox();
    const second = fakeBox();
    const shownFirst: { size?: { width: number; height: number } } = {};
    const shownSecond: { size?: { width: number; height: number } } = {};
    let commits = 0;
    await harness.render(
      <Profiler id="measured" onRender={() => { commits += 1; }}>
        <Measured box={first.box} shown={shownFirst} />
        <Measured box={second.box} shown={shownSecond} />
      </Profiler>,
    );
    // Until measured, the layout's size; a measure that matches it renders nothing.
    expect(shownFirst.size).toEqual({ width: 10, height: 5 });
    commits = 0;
    await act(async () => { first.measure(10, 5); });
    expect(commits).toBe(0);
    await act(async () => { first.measure(10.5, 5.25); });
    expect(shownFirst.size).toEqual({ width: 10.5, height: 5.25 });
    expect(commits).toBe(1);

    const end = beginLiveResize();
    const catchUp = createCatchUp(() => {}, 5);
    commits = 0;
    await act(async () => {
      first.measure(12, 6);
      second.measure(14, 7);
    });
    expect(commits).toBe(0);
    expect(shownFirst.size).toEqual({ width: 10.5, height: 5.25 });
    catchUp.request();
    await wait(30);
    expect(shownFirst.size).toEqual({ width: 12, height: 6 });
    expect(shownSecond.size).toEqual({ width: 14, height: 7 });
    expect(commits).toBe(1);

    commits = 0;
    await act(async () => { first.measure(13, 6); });
    expect(commits).toBe(0);
    await act(async () => { end(); });
    expect(shownFirst.size).toEqual({ width: 13, height: 6 });
    expect(commits).toBe(1);
  });
});
