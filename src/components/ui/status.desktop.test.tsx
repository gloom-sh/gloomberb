import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { EmptyState } from "./status";

const { render, window } = createDomTestHarness();
const prototype = window.HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect };
const measure = prototype.getBoundingClientRect;
afterEach(() => { prototype.getBoundingClientRect = measure; });

/** Lays the page out from `data-left`: an element sits where its nearest marked ancestor does; under `data-hidden` it has no box. */
function layOut() {
  prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.closest("[data-hidden]")) return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 } as DOMRect;
    const left = Number(this.closest("[data-left]")?.getAttribute("data-left") ?? 0);
    return { left, right: left + 100, top: 0, bottom: 18, width: 100, height: 18, x: left, y: 0 } as DOMRect;
  };
}

test("a state flush with its pane's edge takes the inset; one placed by its container, or not laid out yet, is not inset twice", async () => {
  layOut();
  const container = await render(
    <>
      <div data-gloom-role="pane-window" data-left="100" data-pane="bare">
        <EmptyState title="Select a ticker." />
      </div>
      <div data-gloom-role="pane-window" data-left="100" data-pane="placed">
        <div data-left="108"><EmptyState title="No issuer debt." /></div>
      </div>
      <div data-gloom-role="pane-window" data-left="100" data-pane="hidden">
        <div data-left="108" data-hidden=""><EmptyState title="Sign in to browse." /></div>
      </div>
    </>,
  );
  const state = (pane: string) => container.querySelector(`[data-pane="${pane}"] [data-gloom-ui="empty-state"]`) as HTMLElement;
  expect(state("bare").style.padding).toContain("var(--gloom-inset)");
  expect(state("placed").style.padding).toBe("");
  expect(state("hidden").style.padding).toBe("");
});

test("a state 4px in is placed, and one whose container stops padding it takes the inset on the next render", async () => {
  layOut();
  let setLeft!: (left: string) => void;
  function Pane() {
    const [left, update] = useState("103.99");
    setLeft = update;
    return (
      <div data-gloom-role="pane-window" data-left="100">
        <div data-left={left}><EmptyState title="Nothing yet." /></div>
      </div>
    );
  }
  const container = await render(<Pane />);
  const state = () => container.querySelector('[data-gloom-ui="empty-state"]') as HTMLElement;
  expect(state().style.padding).toBe("");
  await act(async () => { setLeft("100"); });
  expect(state().style.padding).toContain("var(--gloom-inset)");
});
