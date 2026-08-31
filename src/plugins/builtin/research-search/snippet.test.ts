import { describe, expect, test } from "bun:test";
import {
  highlightTerms,
  parseMarkedSnippet,
  snippetMatchTerms,
  snippetPlainText,
  truncateSegments,
} from "./snippet";

describe("parseMarkedSnippet", () => {
  test("splits matched runs and joins fragments on one line", () => {
    expect(parseMarkedSnippet("we saw <mark>margin</mark> pressure \u2026 and\nmore <mark>margin</mark> talk")).toEqual([
      { text: "we saw ", marked: false },
      { text: "margin", marked: true },
      { text: " pressure \u2026 and more ", marked: false },
      { text: "margin", marked: true },
      { text: " talk", marked: false },
    ]);
  });

  test("keeps text visible when tags are unbalanced", () => {
    expect(parseMarkedSnippet("cut off at <mark>guidance")).toEqual([
      { text: "cut off at ", marked: false },
      { text: "guidance", marked: true },
    ]);
    expect(parseMarkedSnippet("stray</mark> closer")).toEqual([
      { text: "stray closer", marked: false },
    ]);
  });

  test("treats nested marks as one highlight", () => {
    expect(parseMarkedSnippet("<mark>free <mark>cash</mark> flow</mark> grew")).toEqual([
      { text: "free cash flow", marked: true },
      { text: " grew", marked: false },
    ]);
  });

  test("decodes entities once, so escaped markup stays literal", () => {
    expect(snippetPlainText("AT&amp;T and &amp;lt;mark&amp;gt; and &#39;quoted&#39;")).toBe(
      "AT&T and &lt;mark&gt; and 'quoted'",
    );
  });

  test("collects distinct matched terms", () => {
    expect(snippetMatchTerms("<mark>Margin</mark> and <mark>margin</mark> and <mark>FCF</mark>"))
      .toEqual(["margin", "fcf"]);
  });
});

describe("truncateSegments", () => {
  test("clips inside the run that overflows and marks the cut", () => {
    const segments = parseMarkedSnippet("alpha <mark>bravo</mark> charlie");
    expect(truncateSegments(segments, 9)).toEqual([
      { text: "alpha ", marked: false },
      { text: "br", marked: true },
      { text: "\u2026", marked: false },
    ]);
  });

  test("returns the segments untouched when they already fit", () => {
    const segments = parseMarkedSnippet("<mark>fits</mark>");
    expect(truncateSegments(segments, 10)).toBe(segments);
  });
});

describe("highlightTerms", () => {
  test("matches case-insensitively and prefers the longest term", () => {
    expect(highlightTerms("Free cash flow and cash", ["cash", "free cash flow"])).toEqual([
      { text: "Free cash flow", marked: true },
      { text: " and ", marked: false },
      { text: "cash", marked: true },
    ]);
  });

  test("leaves text intact when no term is usable", () => {
    expect(highlightTerms("plain body", [])).toEqual([{ text: "plain body", marked: false }]);
  });
});
