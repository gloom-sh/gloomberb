import { describe, expect, test } from "bun:test";
import { TEST_FUNCTIONS } from "../pane-links/test-fixture";
import { applyCommandSuggestion, detectChatCommandTrigger, filterCommandSuggestions } from "./command-suggestions";

const triggerAtEnd = (draft: string) => detectChatCommandTrigger(draft, draft.length);

describe("chat function suggestions", () => {
  test("start after an opening backtick, never a closing one, a word's inside or a code block", () => {
    expect(triggerAtEnd("try `ni")).toEqual({ start: 4, end: 7, query: "ni" });
    expect(triggerAtEnd("`NI CRYPTO` and `CR")).toEqual({ start: 16, end: 19, query: "CR" });
    // The backtick closes the span "`NI CRYPTO and `" opened.
    expect(triggerAtEnd("`NI CRYPTO and `CR")).toBeNull();
    expect(triggerAtEnd("try `")).toBeNull();
    expect(triggerAtEnd("a`b")).toBeNull();
    expect(triggerAtEnd("```\nsome code `DE")).toBeNull();
    expect(triggerAtEnd("```\ncode\n```\nthen `DE")).toEqual({ start: 18, end: 21, query: "DE" });
    expect(detectChatCommandTrigger("try `NI CRYPTO`", 7)).toEqual({ start: 4, end: 7, query: "NI" });
  });

  test("offer codes that start with what is typed, the exact and shortest first, then names", () => {
    expect(filterCommandSuggestions(TEST_FUNCTIONS, "n").map((suggestion) => suggestion.code)).toEqual(["N", "NI"]);
    expect(filterCommandSuggestions(TEST_FUNCTIONS, "fh").map((suggestion) => suggestion.code)).toEqual(["N"]);
    expect(filterCommandSuggestions(TEST_FUNCTIONS, "crypto").map((suggestion) => suggestion.code)).toEqual(["CRYP"]);
    // A code the bar runs as a command that changes things is never offered.
    expect(filterCommandSuggestions(TEST_FUNCTIONS, "aw")).toEqual([]);
  });

  test("put the code between backticks, the cursor inside for an argument and past the span otherwise", () => {
    const [crypto] = filterCommandSuggestions(TEST_FUNCTIONS, "cry");
    expect(applyCommandSuggestion("see `cry", triggerAtEnd("see `cry")!, crypto!)).toEqual({ draft: "see `CRYP` ", cursorOffset: 11 });
    expect(applyCommandSuggestion("see `cry, then", detectChatCommandTrigger("see `cry, then", 8)!, crypto!))
      .toEqual({ draft: "see `CRYP`, then", cursorOffset: 10 });
    const [description] = filterCommandSuggestions(TEST_FUNCTIONS, "des");
    expect(applyCommandSuggestion("see `de", triggerAtEnd("see `de")!, description!)).toEqual({ draft: "see `DES `", cursorOffset: 9 });
    // A closing backtick already typed is the one the span ends with.
    expect(applyCommandSuggestion("see `de` now", detectChatCommandTrigger("see `de` now", 7)!, description!))
      .toEqual({ draft: "see `DES ` now", cursorOffset: 9 });
  });
});
