import { expect, test } from "bun:test";
import { scrollTruncationReasons, type ScrollBoxMetrics } from "./scroll-truncation";

const box = (overrides: Partial<ScrollBoxMetrics>): ScrollBoxMetrics => ({
  scrollTop: 0, scrollHeight: 400, clientHeight: 400,
  scrollLeft: 0, scrollWidth: 800, clientWidth: 800,
  scrollbarY: false, scrollbarX: false,
  ...overrides,
});

test("names the side a capture cuts rows and columns from", () => {
  // A list at its top, a chain centred on the money, a list scrolled to its end.
  expect(scrollTruncationReasons(box({ scrollHeight: 1000 }))).toEqual(["rows below the rendered viewport are cut"]);
  expect(scrollTruncationReasons(box({ scrollHeight: 1000, scrollTop: 300 }))).toEqual(["rows above and below the rendered viewport are cut"]);
  expect(scrollTruncationReasons(box({ scrollHeight: 1000, scrollTop: 600 }))).toEqual(["rows above the rendered viewport are cut"]);
  expect(scrollTruncationReasons(box({ scrollWidth: 1200, scrollLeft: 400 }))).toEqual(["columns left of the rendered viewport are cut"]);
  expect(scrollTruncationReasons(box({ scrollWidth: 1200, scrollLeft: 100 })))
    .toEqual(["columns left and right of the rendered viewport are cut"]);
});

test("a drawn scrollbar counts as overflow even when the measures fit, and a pixel of layout slack does not", () => {
  expect(scrollTruncationReasons(box({ scrollbarY: true, scrollbarX: true }))).toEqual([
    "rows above or below the rendered viewport may be cut",
    "columns left or right of the rendered viewport may be cut",
  ]);
  expect(scrollTruncationReasons(box({ scrollHeight: 401, scrollWidth: 801 }))).toEqual([]);
});

test("runs from its own source, as the screenshot runner evaluates it in the page", () => {
  const inPage = new Function(`return (${scrollTruncationReasons.toString()});`)() as typeof scrollTruncationReasons;
  expect(inPage(box({ scrollHeight: 1000, scrollTop: 300 }))).toEqual(["rows above and below the rendered viewport are cut"]);
});
