import { describe, expect, test } from "bun:test";
import { isEditableTarget, shouldReleaseFocus } from "./focus-scope";

function field(scope?: { contains: (node: unknown) => boolean }) {
  return {
    tagName: "INPUT",
    closest: () => scope ?? null,
    contains: (node: unknown) => node === undefined,
  };
}

describe("focus scope release", () => {
  test("releases focus for a press outside the widget that owns it", () => {
    expect(shouldReleaseFocus(field(), { tagName: "DIV" })).toBe(true);
  });

  test("keeps focus for a press on the owning widget's own chrome", () => {
    const suggestion = { tagName: "DIV" };
    expect(shouldReleaseFocus(field({ contains: (n) => n === suggestion }), suggestion)).toBe(false);
  });

  test("ignores presses while nothing editable holds focus", () => {
    expect(shouldReleaseFocus({ tagName: "DIV", closest: () => null }, {})).toBe(false);
    expect(shouldReleaseFocus(null, {})).toBe(false);
  });

  test("leaves a press inside a dialog alone, which owns the pointer itself", () => {
    const inDialog = { tagName: "INPUT", closest: (selector: string) => selector === ".gloom-dialog" ? {} : null };
    expect(shouldReleaseFocus(field(), inDialog)).toBe(false);
  });

  test("recognises the field a press is about to focus", () => {
    expect(isEditableTarget({ tagName: "textarea" })).toBe(true);
    expect(isEditableTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "canvas" })).toBe(false);
  });
});
