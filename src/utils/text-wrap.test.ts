import { expect, test } from "bun:test";
import { displayWidth } from "./format";
import { wrapSegmentLines, wrapTextLines } from "./text-wrap";

test("CJK paragraphs wrap by display cells without losing quote characters", () => {
  for (const quote of ["당사의 주요 매출처는 Alphabet, Apple 등 입니다. 전체 매출액 대비 약 15% 수준입니다.",
    "販売高には、当該顧客と同一の企業集団に属する顧客に対する販売高を含めております。",
    "Sales: 台灣積體電路製造股份有限公司 315,813 JPY million."]) {
    for (const width of [8, 21, 77]) {
      const lines = wrapTextLines(quote, width);
      expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
      expect(lines.join("").replace(/\s/g, "")).toBe(quote.replace(/\s/g, ""));
    }
    expect(wrapTextLines(quote, 21, 2).every((line) => displayWidth(line) <= 21)).toBe(true);
  }
});

/** Review, 12 Nov 2026: the Changelog broke `(0.20.0)` as `(0.` / `20.0)`. */
test("styled runs wrap only at whitespace, keep their styles across a break, and cut only a word wider than a line", () => {
  const text = (lines: Array<Array<{ text: string }>>) => lines.map((line) => line.map((segment) => segment.text).join(""));
  const segments = [
    { text: "  Shipped in ", bold: false },
    { text: "(0.20.0)", bold: true },
    { text: " with gloom.sh/docs/changelog links", bold: false },
  ];
  const lines = wrapSegmentLines(segments, 22);
  expect(text(lines)).toEqual(["  Shipped in (0.20.0)", "with", "gloom.sh/docs/changelo", "g links"]);
  expect(lines[0]!.at(-1)).toEqual({ text: "(0.20.0)", bold: true });
  expect(lines.every((line) => displayWidth(line.map((segment) => segment.text).join("")) <= 22)).toBe(true);
  expect(text(wrapSegmentLines([{ text: "a b" }], 80))).toEqual(["a b"]);
});
