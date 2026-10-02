import { describe, expect, test } from "bun:test";
import { hasWebCtrlModifier, normalizeWebKeyName, shouldConsumeWebAppKeyDown, webKeySequence } from "./key-event";

function keyEvent(overrides: Record<string, unknown>) {
  return {
    key: "x",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: null,
    ...overrides,
  } as never;
}

describe("shouldConsumeWebAppKeyDown", () => {
  test("consumes non-editable app keydowns", () => {
    expect(shouldConsumeWebAppKeyDown(keyEvent({ key: "+" }))).toBe(true);
    expect(shouldConsumeWebAppKeyDown(keyEvent({ key: "ArrowDown", target: { tagName: "DIV" } }))).toBe(true);
  });

  test("preserves native editing and control targets", () => {
    expect(shouldConsumeWebAppKeyDown(keyEvent({ target: { tagName: "INPUT" } }))).toBe(false);
    expect(shouldConsumeWebAppKeyDown(keyEvent({ target: { tagName: "TEXTAREA" } }))).toBe(false);
    expect(shouldConsumeWebAppKeyDown(keyEvent({ target: { tagName: "DIV", isContentEditable: true } }))).toBe(false);
    expect(shouldConsumeWebAppKeyDown(keyEvent({ key: "Enter", target: { tagName: "BUTTON" } }))).toBe(false);
    expect(shouldConsumeWebAppKeyDown(keyEvent({ key: "+", target: { tagName: "BUTTON" } }))).toBe(true);
  });

  test("preserves browser modifier shortcuts unless they are terminal-style ctrl-shift shortcuts", () => {
    expect(shouldConsumeWebAppKeyDown(keyEvent({ key: "c", ctrlKey: true }))).toBe(false);
    expect(shouldConsumeWebAppKeyDown(keyEvent({ key: "c", metaKey: true }))).toBe(false);
    expect(shouldConsumeWebAppKeyDown(keyEvent({ key: "c", ctrlKey: true, shiftKey: true }))).toBe(true);
  });
});

test("a keydown without a key, as browser autofill sends, normalizes instead of throwing", () => {
  const autofill = keyEvent({ key: undefined });
  expect(normalizeWebKeyName(undefined)).toBe("");
  expect(webKeySequence(autofill)).toBe("");
  expect(hasWebCtrlModifier(autofill)).toBe(false);
});
