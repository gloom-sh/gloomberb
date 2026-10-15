import { describe, expect, test } from "bun:test";
import { chatInlineTokens, chatPlainText } from "./markdown";

describe("chat markdown", () => {
  test("a written link opens only a web address, and its host shows unless the label names it", () => {
    expect(chatInlineTokens("[the docs](https://gloom.sh/docs)")).toEqual([
      { kind: "link", value: "the docs", url: "https://gloom.sh/docs" },
      { kind: "text", value: " (gloom.sh)", style: { muted: true } },
    ]);
    expect(chatInlineTokens("[gloom.sh/docs](https://www.gloom.sh/docs)")).toEqual([
      { kind: "link", value: "gloom.sh/docs", url: "https://www.gloom.sh/docs" },
    ]);
    expect(chatInlineTokens("[gloom.sh](https://gloom.sh.example.net/login)").at(-1)).toEqual(
      { kind: "text", value: " (gloom.sh.example.net)", style: { muted: true } },
    );
    expect(chatInlineTokens("[x.com/login](https://x.co/login)").at(-1)).toEqual(
      { kind: "text", value: " (x.co)", style: { muted: true } },
    );
    for (const text of ["[x](javascript:alert(1))", "[x](file:///etc/passwd)", "[x](data:text/html,hi)"]) {
      expect(chatInlineTokens(text)).toEqual([{ kind: "text", value: text }]);
    }
  });

  test("code is text: no ticker, mention or link inside it", () => {
    expect(chatInlineTokens("`$TSLA @quill https://gloom.sh` $TSLA")).toEqual([
      { kind: "text", value: "$TSLA @quill https://gloom.sh", style: { code: true } },
      { kind: "text", value: " " },
      { kind: "ticker", value: "$TSLA", symbol: "TSLA" },
    ]);
  });

  test("a quote or a notification reads the message without its marks", () => {
    expect(chatPlainText("**No price yet:** see [the docs](https://gloom.sh/docs)\n- `search CLAU`\n```\nx = 1\n```"))
      .toBe("No price yet: see the docs\n- search CLAU\nx = 1");
  });
});
