import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { capturePaneScreenshotPngBase64, ellipsized, renderedTextFragments } from "./dom-screenshot";

function measuredLines(lines: { text: string; left: number; top: number }[]) {
  const value = lines.map((line) => line.text).join("");
  const boundaries: { start: number; end: number; left: number; top: number }[] = [];
  let offset = 0;
  for (const line of lines) {
    boundaries.push({ start: offset, end: offset + line.text.length, left: line.left, top: line.top });
    offset += line.text.length;
  }
  return { value, measure: (start: number, end: number) => boundaries.flatMap((line) => {
    const from = Math.max(start, line.start);
    const to = Math.min(end, line.end);
    return to > from ? [{ left: line.left + (from - line.start) * 8, top: line.top, width: (to - from) * 8, height: 16 }] : [];
  }) };
}

test("screenshot text retains a soft-wrapped research caveat on its measured lines", () => {
  const fixture = measuredLines([
    { text: "Latest available statements. SEC EPS uses ", left: 8, top: 20 },
    { text: "corroborated split-adjusted share bases. ", left: 8, top: 38 },
    { text: "Unverified bases are unavailable.", left: 8, top: 56 },
  ]);
  const result = renderedTextFragments(fixture.value, fixture.measure);
  expect(result.map((fragment) => fragment.value)).toEqual([
    "Latest available statements. SEC EPS uses ",
    "corroborated split-adjusted share bases. ", "Unverified bases are unavailable.",
  ]);
  expect(result.map((fragment) => fragment.rect.top)).toEqual([20, 38, 56]);
  expect(result.map((fragment) => fragment.value).join("")).toBe(fixture.value);
});

test("line fragments preserve explicit breaks, blank-line spacing and inline indentation", () => {
  const fixture = measuredLines([
    { text: "first\n\n", left: 40, top: 10 },
    { text: "second ", left: 8, top: 46 },
    { text: "wrapped", left: 8, top: 64 },
  ]);
  expect(renderedTextFragments(fixture.value, fixture.measure).map(({ value, rect }) => [value, rect.left, rect.top]))
    .toEqual([["first\n\n", 40, 10], ["second ", 8, 46], ["wrapped", 8, 64]]);
});

test("range probes keep surrogate pairs intact and invisible text terminates", () => {
  const fixture = measuredLines([{ text: "USD 🧾 ", left: 0, top: 0 }, { text: "evidence", left: 0, top: 18 }]);
  const result = renderedTextFragments(fixture.value, (start, end) => {
    expect(start).not.toBe(5); expect(end).not.toBe(5);
    return fixture.measure(start, end);
  });
  expect(result.map((fragment) => fragment.value)).toEqual(["USD 🧾 ", "evidence"]);
  expect(renderedTextFragments("hidden", () => [])).toEqual([]);
});

test("a label cut by its box ends in an ellipsis inside the box, never splitting a character", () => {
  const monospace = (text: string) => Array.from(text).length * 8;
  expect(ellipsized(monospace, "Dow Jones Industrial Average", 120)).toBe("Dow Jones Indu\u2026");
  expect(ellipsized(monospace, "USD 🧾 evidence", 56)).toBe("USD 🧾 \u2026");
  expect(ellipsized(monospace, "Nikkei", 4)).toBe("\u2026");
});

test("a failed screenshot image restores canvas state before painting the next element", async () => {
  const window = new Window();
  const globals = {
    document: window.document,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    SVGSVGElement: window.SVGSVGElement,
    HTMLImageElement: window.HTMLImageElement,
    HTMLCanvasElement: window.HTMLCanvasElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Node: window.Node,
    DOMRect: window.DOMRect,
    FileReader: window.FileReader,
    getComputedStyle: window.getComputedStyle.bind(window),
    devicePixelRatio: 1,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const canvasPrototype = window.HTMLCanvasElement.prototype;
  const canvasMethods = ["getContext", "toBlob"].map((key) => [key, Object.getOwnPropertyDescriptor(canvasPrototype, key)] as const);
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    const pane = window.document.createElement("div");
    pane.dataset.gloomPaneId = "raster-failure";
    const image = window.document.createElement("img");
    image.style.opacity = "0.25";
    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 50 },
      naturalHeight: { value: 50 },
    });
    const next = window.document.createElement("canvas");
    pane.append(image, next);
    window.document.body.append(pane);
    for (const [element, rect] of [
      [pane, new window.DOMRect(0, 0, 300, 100)],
      [image, new window.DOMRect(0, 0, 50, 50)],
      [next, new window.DOMRect(100, 0, 50, 50)],
    ] as const) Object.defineProperty(element, "getBoundingClientRect", { value: () => rect });

    for (const failureAt of ["clip", "draw"] as const) {
      const saved: number[] = [];
      const nextAlphas: number[] = [];
      let failures = 0;
      const context = {
        globalAlpha: 1,
        save() { saved.push(this.globalAlpha); },
        restore() { this.globalAlpha = saved.pop()!; },
        scale() {}, clearRect() {}, beginPath() {}, rect() {},
        clip() {
          if (failureAt === "clip") { failures += 1; throw new Error("Clip failed"); }
        },
        drawImage(source: unknown) {
          if (source === image) { failures += 1; throw new Error("Image draw failed"); }
          if (source === next) nextAlphas.push(this.globalAlpha);
        },
      };
      Object.defineProperties(canvasPrototype, {
        getContext: { configurable: true, value(this: { width: number }) {
          // The one-pixel readability probe succeeds before the full-size draw fails.
          return this.width === 1 ? { drawImage() {}, getImageData() {} } : context;
        } },
        toBlob: { configurable: true, value(callback: (blob: unknown) => void) {
          callback(new window.Blob(["image"], { type: "image/png" }));
        } },
      });

      await capturePaneScreenshotPngBase64("raster-failure");

      expect(failures).toBe(1);
      expect(nextAlphas).toEqual([1]);
      expect(saved).toEqual([]);
      expect(context.globalAlpha).toBe(1);
    }
  } finally {
    await window.happyDOM.abort();
    for (const [key, descriptor] of canvasMethods) {
      if (descriptor) Object.defineProperty(canvasPrototype, key, descriptor);
      else Reflect.deleteProperty(canvasPrototype, key);
    }
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
