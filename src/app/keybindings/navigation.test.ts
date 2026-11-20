import { expect, test } from "bun:test";
import { matchesNavigationKey } from "./navigation";
import { coreActionOnChord, matchKeybinding, resolveKeybindings } from "./resolve";
import { parseKeyChord } from "./chord";
import { applyKeybindingCliSet } from "../../cli/commands/keybindings";
import { createDefaultConfig } from "../../types/config";
import { listCursorMove } from "../../components/ui/list-view";
import { directionFromWindowEditKey } from "../../components/layout/window-edit/mode";

const bindings = resolveKeybindings({ actions: {
  "navigate-left": ["C", "Left"], "navigate-right": "T",
  "navigate-up": "é", "navigate-down": "è",
} });

test("navigation overrides replace defaults, stay local and preserve explicit arrows", () => {
  expect(bindings.issues).toEqual([]);
  expect(matchesNavigationKey(bindings, "left", { name: "c" })).toBe(true);
  expect(matchesNavigationKey(bindings, "left", { name: "h" })).toBe(false);
  expect(matchesNavigationKey(bindings, "left", { name: "left" })).toBe(true);
  expect(matchesNavigationKey(bindings, "right", { name: "right" })).toBe(false);
  expect(matchKeybinding(bindings, { name: "c" })).toBeNull();
  expect(matchesNavigationKey(resolveKeybindings({ actions: { "navigate-left": null } }), "left", { name: "left" })).toBe(false);
  expect(directionFromWindowEditKey({ name: "c", shift: true }, bindings)).toBe("left");
  expect(directionFromWindowEditKey({ name: "h" }, bindings)).toBeNull();
});

test("list navigation honours non-US letters and leaves text and editing in a field", () => {
  const rows = [{}, { disabled: true }, {}];
  expect(listCursorMove({ name: "è" }, 2, bindings)?.(rows, 0)).toBe(2);
  expect(listCursorMove({ name: "é" }, 2, bindings)?.(rows, 2)).toBe(0);
  expect(listCursorMove({ name: "j" }, 2, bindings)).toBeNull();
  expect(listCursorMove({ name: "è", targetEditable: true }, 2, bindings)).toBeNull();
  const defaults = resolveKeybindings(undefined);
  expect(listCursorMove({ name: "down", targetEditable: true }, 2, defaults)?.(rows, 0)).toBe(2);
  expect(matchesNavigationKey(defaults, "left", { name: "left", targetEditable: true })).toBe(false);
});

test("window mode keeps arrows and acceleration over an editable target without taking letters", () => {
  expect(directionFromWindowEditKey({ name: "left", targetEditable: true })).toBe("left");
  expect(directionFromWindowEditKey({ name: "up", shift: true, targetEditable: true })).toBe("up");
  expect(directionFromWindowEditKey({ name: "h", targetEditable: true })).toBeNull();
  expect(directionFromWindowEditKey({ name: "c", targetEditable: true }, bindings)).toBeNull();
});

test("navigation conflicts are rejected in the CLI and hand-edited collisions keep global precedence", () => {
  const config = createDefaultConfig(":memory:");
  expect(applyKeybindingCliSet(config, "keybindings.actions.navigate-right", "R")).toMatchObject({ ok: false });
  expect(applyKeybindingCliSet(config, "keybindings.actions.navigate-right", "T Right")).toMatchObject({ ok: true });
  expect(coreActionOnChord(bindings, parseKeyChord("C")!)?.id).toBe("navigate-left");
  const conflict = resolveKeybindings({ actions: { "navigate-right": "R" } });
  expect(conflict.issues).toContainEqual(expect.objectContaining({ kind: "conflict", targets: ["refresh-ticker", "navigate-right"] }));
  expect(matchesNavigationKey(conflict, "right", { name: "r" })).toBe(false);
  expect(matchKeybinding(conflict, { name: "r" })).toMatchObject({ id: "refresh-ticker" });
});

test("only an explicit layout binding accepts shifted Bépo digits decoded from the terminal protocol", async () => {
  const { parseKeypress } = await import("@opentui/core");
  const { toKeyEventLike } = await import("../../renderers/opentui/host");
  const defaults = resolveKeybindings(undefined, { host: "terminal" });
  const shifted = resolveKeybindings({ actions: { "switch-layout": ["CmdOrCtrl+Shift+Digit", "Alt+Shift+Digit"] } });
  // Unshifted double quote, shifted 1, and Ctrl+Shift in kitty's encoding.
  const parsed = parseKeypress("\x1b[34:49;6u", { useKittyKeyboard: true })!;
  expect(parsed).toMatchObject({ name: '"', sequence: "1", ctrl: true, shift: true });
  expect(matchKeybinding(defaults, toKeyEventLike(parsed))).toBeNull();
  expect(matchKeybinding(shifted, toKeyEventLike(parsed))).toMatchObject({ id: "switch-layout", digit: 1 });
  const alt = parseKeypress("\x1b[34:49;4u", { useKittyKeyboard: true })!;
  expect(matchKeybinding(defaults, toKeyEventLike(alt))).toBeNull();
  expect(matchKeybinding(shifted, toKeyEventLike(alt))).toMatchObject({ id: "switch-layout", digit: 1 });
  expect(matchKeybinding(defaults, { name: "1", meta: true, shift: true })).toBeNull();
});
