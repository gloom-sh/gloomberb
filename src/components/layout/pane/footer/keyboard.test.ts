import { expect, test } from "bun:test";
import type { KeyEventLike } from "../../../../react/input";
import { resolvePaneFooterKey } from "./keyboard";
import { paneHintTitle, type CombinedPaneFooter } from "./model";

function key(name: string, modifiers: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key: name,
    name,
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    preventDefault() {},
    stopPropagation() {},
    ...modifiers,
  };
}

const pressed: string[] = [];
const footer: CombinedPaneFooter = {
  info: [
    { id: "warnings", parts: [{ text: "2 warnings" }], shortcut: "!", onPress: () => pressed.push("warnings") },
  ],
  hints: [
    { id: "add", key: "a", label: "dd", onPress: () => pressed.push("add") },
    { id: "save", key: "Ctrl+S", label: "save", onPress: () => pressed.push("save") },
    { id: "edit", key: "e", label: "dit", disabled: true, onPress: () => pressed.push("edit") },
    { id: "label-only", key: "x", label: "nothing" },
  ],
  menu: [],
  keys: [],
};

test("a footer hint's key presses it, and only an enabled hint with an action", () => {
  pressed.length = 0;
  resolvePaneFooterKey(footer, key("a"), false)?.();
  resolvePaneFooterKey(footer, key("s", { ctrl: true }), false)?.();
  resolvePaneFooterKey(footer, key("!"), false)?.();
  expect(pressed).toEqual(["add", "save", "warnings"]);
  expect(resolvePaneFooterKey(footer, key("e"), false)).toBeNull();
  expect(resolvePaneFooterKey(footer, key("x"), false)).toBeNull();
  expect(resolvePaneFooterKey(footer, key("a", { shift: true }), false)).toBeNull();
});

test("a field that owns the keyboard keeps typed characters but not modified chords", () => {
  expect(resolvePaneFooterKey(footer, key("a"), true)).toBeNull();
  expect(resolvePaneFooterKey(footer, key("s", { ctrl: true }), true)).not.toBeNull();
});

test("the pane menu reads a hint as the action it names", () => {
  expect(paneHintTitle({ key: "a", label: "dd" })).toBe("Add");
  expect(paneHintTitle({ key: "r", label: "retry" })).toBe("Retry");
  expect(paneHintTitle({ key: "x", label: " remove" })).toBe("Remove");
  expect(paneHintTitle({ key: "Ctrl+S", label: "save search" })).toBe("Save search");
  expect(paneHintTitle({ key: "x", label: "port all", title: "Export All" })).toBe("Export All");
});
