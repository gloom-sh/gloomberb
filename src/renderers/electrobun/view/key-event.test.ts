import { describe, expect, test } from "bun:test";
import {
  shouldConsumeWebAppKeyDown,
  shouldDispatchWebAppKeyDown,
  shouldDispatchWebNativeKeyDown,
} from "./key-event";

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

  test("leaves native Tab focus traversal available from the app root and its controls", () => {
    const root = { tagName: "DIV", getAttribute: (name: string) => name === "id" ? "root" : null };
    const button = { tagName: "BUTTON" };

    for (const target of [root, button]) {
      const event = keyEvent({ key: "Tab", target });
      expect(shouldDispatchWebAppKeyDown(event)).toBe(false);
      expect(shouldConsumeWebAppKeyDown(event)).toBe(false);
    }
    expect(shouldDispatchWebAppKeyDown(keyEvent({ key: "Tab", shiftKey: true, target: button }))).toBe(false);
  });

  test("bypasses app shortcut dispatch for native control activation keys", () => {
    const button = { tagName: "BUTTON" };
    const link = { tagName: "A", getAttribute: (name: string) => name === "href" ? "/details" : null };
    const buttonChild = {
      tagName: "SVG",
      closest: (selector: string) => selector.includes("button") ? button : null,
    };

    for (const key of ["Enter", "Return", " "]) {
      for (const target of [button, buttonChild, link, { tagName: "SUMMARY" }]) {
        expect(shouldDispatchWebAppKeyDown(keyEvent({ key, target }))).toBe(false);
      }
    }

    expect(shouldDispatchWebAppKeyDown(keyEvent({ key: "+", target: button }))).toBe(true);
    expect(shouldDispatchWebAppKeyDown(keyEvent({ key: "Enter", target: { tagName: "A", getAttribute: () => null } }))).toBe(true);
  });

  test("keeps native renderer keypresses out of editable DOM controls", () => {
    const editableTargets = [
      { tagName: "INPUT" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
      { tagName: "SPAN", closest: (selector: string) => selector.includes("contenteditable") ? {} : null },
    ];

    for (const target of editableTargets) {
      expect(shouldDispatchWebNativeKeyDown(keyEvent({ key: "x", target }))).toBe(false);
      expect(shouldDispatchWebNativeKeyDown(keyEvent({ key: "Enter", target }))).toBe(false);
    }
  });
});
