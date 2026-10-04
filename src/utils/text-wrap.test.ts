import { expect, test } from "bun:test";
import { displayWidth } from "./format";
import { wrapTextLines } from "./text-wrap";

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
