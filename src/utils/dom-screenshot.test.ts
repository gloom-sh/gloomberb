import { expect, test } from "bun:test";
import { renderedTextFragments } from "./dom-screenshot";

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
