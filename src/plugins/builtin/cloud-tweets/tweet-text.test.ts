import { describe, expect, test } from "bun:test";
import { normalizeTweetText } from "./tweet-text";

describe("normalizeTweetText", () => {
  test("preserves tweet line breaks for detail rendering", () => {
    expect(normalizeTweetText("First&nbsp;line\r\n\r\nSecond\tline", { preserveLineBreaks: true }))
      .toBe("First line\n\nSecond line");
  });

  test("collapses tweet line breaks for compact table rendering", () => {
    expect(normalizeTweetText("First&nbsp;line\nSecond\tline")).toBe("First line Second line");
  });
});
