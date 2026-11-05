import { describe, expect, test } from "bun:test";
import { parseInlineMarkdown, parseMarkdownLines } from "./markdown";

describe("parseInlineMarkdown", () => {
  test("reads the marks a message is written with", () => {
    expect(parseInlineMarkdown("**No price yet:** it hasn't traded, `search CLAU`")).toEqual([
      { text: "No price yet:", bold: true },
      { text: " it hasn't traded, " },
      { text: "search CLAU", code: true },
    ]);
    expect(parseInlineMarkdown("_one_ *two* ~~three~~ ``a ` tick``")).toEqual([
      { text: "one", italic: true },
      { text: " " },
      { text: "two", italic: true },
      { text: " " },
      { text: "three", strike: true },
      { text: " " },
      { text: "a ` tick", code: true },
    ]);
  });

  test("a link's label may escape its brackets, and an unescaped one starts the label anew", () => {
    expect(parseInlineMarkdown("up 2% [\\[3\\]](x)\\[5\\]", { links: true })).toEqual([
      { text: "up 2% " },
      { text: "[3]", link: "x" },
      { text: "[5]" },
    ]);
    expect(parseInlineMarkdown("a [b\\](x) [c](d)", { links: true })).toEqual([
      { text: "a [b](x) " },
      { text: "c", link: "d" },
    ]);
  });

  // Each of these once read as a mark and swallowed the text after it.
  test.each([
    "2 * 3 * 4 = 24",
    "a lone ` and a lone *, then the rest of the message",
    "**an unclosed bold and an `unclosed code",
    "snake_case_name, a_b_c, __init__ and @john_doe_x",
    "https://example.com/a_b_/c*d*e*?q=_x_",
  ])("leaves %p as written", (text) => {
    expect(parseInlineMarkdown(text)).toEqual([{ text }]);
  });
});

describe("parseMarkdownLines", () => {
  test("reads a closed fence as code, and an unclosed one as text that leaves the rest alone", () => {
    expect(parseMarkdownLines("```ts\nconst pe = 1;\n\n```\n> quote\n>_<\n- item\n1. step\n# Title\n```\n**still** text")).toEqual([
      { kind: "code", text: "const pe = 1;" },
      { kind: "code", text: "" },
      { kind: "quote", text: "quote" },
      { kind: "text", text: ">_<" },
      { kind: "list", indent: 0, marker: "-", text: "item" },
      { kind: "list", indent: 0, marker: "1.", text: "step" },
      { kind: "heading", text: "Title" },
      { kind: "text", text: "```" },
      { kind: "text", text: "**still** text" },
    ]);
  });
});
