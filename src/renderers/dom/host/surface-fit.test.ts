import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { beginLiveResize } from "../../../ui/live-resize";
import { RESIZE_SETTLE_MS } from "../../../ui/resize-settle";
import { trackTableResize } from "./surface-fit";

test("table following preserves nested visible gaps through release, late commits and regrab", async () => {
  const window = new Window();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  const frame = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  // happy-dom does not lay out flex boxes. Model this nested stretch chain;
  // the browser regressions exercise its actual CSS and interpolated frames.
  const interpolated = new Map<HTMLElement, number>();
  const margin = (element: HTMLElement) => interpolated.get(element)
    ?? (parseFloat(element.hasAttribute("data-gloom-follow-gap-x")
      ? element.style.getPropertyValue("--gloom-follow-x-margin") : element.style.marginRight) || 0);
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element) => {
    const style = computed(element);
    return new Proxy(style, { get(target, property) {
      return property === "marginRight" ? `${margin(element as unknown as HTMLElement)}px` : Reflect.get(target, property);
    } });
  };
  function box(parent: HTMLElement | null, width?: number, trailing = 0): HTMLElement {
    const element = window.document.createElement("div") as unknown as HTMLElement;
    element.style.cssText = `display:flex;flex-direction:column;align-items:stretch;margin-right:${trailing}px`;
    if (width !== undefined) element.style.width = `${width}px`;
    (parent ?? window.document.body).appendChild(element as never);
    element.getBoundingClientRect = () => {
      const follows = element.hasAttribute("data-gloom-follow-x") || element.hasAttribute("data-gloom-fill-x");
      const actual = width === undefined || follows
        ? (parent?.getBoundingClientRect().width ?? 0) - margin(element) : parseFloat(element.style.width);
      return new window.DOMRect(0, 0, actual, 100) as unknown as DOMRect;
    };
    element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList;
    return element;
  }
  const pane = box(null, 643);
  pane.setAttribute("data-gloom-role", "pane-content");
  const outer = box(pane, 638, 2);
  const inner = box(outer, 634);
  const table = box(inner);
  // A chart may already fill another ancestor that the table also uses.
  const filledPane = box(null, 643);
  filledPane.setAttribute("data-gloom-role", "pane-content");
  const filled = box(filledPane, 638);
  filled.setAttribute("data-gloom-fill-x", "stretch");
  const stopTracking = [trackTableResize(table), trackTableResize(box(filled))];
  let end = beginLiveResize();
  try {
    expect(outer.getBoundingClientRect().width).toBe(638);
    expect(inner.getBoundingClientRect().width).toBe(634);
    expect(filled.getBoundingClientRect().width).toBe(643);
    expect(filled.style.getPropertyValue("--gloom-follow-x-margin")).toBe("0px");

    pane.style.width = "657px";
    outer.style.width = "652px";
    inner.style.width = "650px";
    expect(inner.getBoundingClientRect().width).toBe(648);
    end();
    expect(inner.getBoundingClientRect().width).toBe(648);
    frame();
    // The inner target must use the normal 652 px parent, not its current
    // animated width. Only its own 2 px resting gap belongs in the margin.
    expect(inner.style.getPropertyValue("--gloom-follow-x-margin")).toBe("2px");

    outer.style.width = "654px";
    inner.style.width = "651px";
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Retargeting is queued, but the browser can miss its next frame. The
    // previous cleanup deadline must not remove the held gap first.
    await new Promise((resolve) => setTimeout(resolve, RESIZE_SETTLE_MS * 2 + 10));
    expect(inner.hasAttribute("data-gloom-follow-x")).toBe(true);
    expect(inner.style.getPropertyValue("--gloom-follow-x-margin")).toBe("2px");
    frame();
    expect(outer.style.getPropertyValue("--gloom-follow-x-margin")).toBe("3px");
    expect(inner.style.getPropertyValue("--gloom-follow-x-margin")).toBe("3px");

    interpolated.set(outer, 4);
    interpolated.set(inner, 2.5);
    const visible = inner.getBoundingClientRect().width;
    end = beginLiveResize();
    interpolated.clear();
    expect(inner.getBoundingClientRect().width).toBe(visible);
    expect(inner.hasAttribute("data-gloom-follow-settling")).toBe(false);
    end();
    frame();
    await new Promise((resolve) => setTimeout(resolve, RESIZE_SETTLE_MS * 2 + 10));
    expect(inner.hasAttribute("data-gloom-follow-x")).toBe(false);
    expect(inner.style.getPropertyValue("--gloom-follow-x-margin")).toBe("");
    expect(outer.style.marginRight).toBe("2px");
    expect(inner.getBoundingClientRect().width).toBe(651);
    expect(filled.hasAttribute("data-gloom-fill-x")).toBe(true);
  } finally {
    end();
    frame();
    await new Promise((resolve) => setTimeout(resolve, RESIZE_SETTLE_MS * 2 + 10));
    for (const stop of stopTracking) stop();
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
    await window.happyDOM.abort();
  }
});
