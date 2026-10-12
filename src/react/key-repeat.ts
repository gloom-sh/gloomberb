import type { KeyEventLike } from "./input";

type RepeatKey = Pick<KeyEventLike, "name" | "key" | "ctrl" | "meta" | "super" | "shift" | "alt" | "targetEditable">;

/**
 * Holding a key makes the platform send it again about thirty times a second
 * (`repeat` on a DOM key event, the repeat event type of the kitty keyboard
 * protocol). Most of what a key does should happen once per press, so the
 * shortcut registry drops a repeat before any handler sees it unless the key
 * is meant to repeat.
 *
 * Only keys that run a command are held to that: a command chord (Ctrl, Cmd or
 * Super with a key), Escape, a function key and the menu key. Letters,
 * digits, Enter, Space and the other plain keys pass untouched, because a pane
 * binds them for typing, stepping and zooming (j and k, + and -, [ and ]) and
 * nothing here can tell those from a one-shot. The core actions bound to a
 * plain key (help, refresh, the pane menu) fire once through the cooldown on
 * their own handlers instead.
 *
 * A command key repeats when it is on the allow-list below.
 */

/** Move, scroll, select and delete, with any modifier: Ctrl+Left, Cmd+Backspace, Shift+Down. */
const REPEATING_KEY_NAMES: ReadonlySet<string> = new Set([
  "up",
  "down",
  "left",
  "right",
  "pageup",
  "pagedown",
  "home",
  "end",
  "tab",
  "backspace",
  "delete",
]);

/** Ctrl+N and Ctrl+P step a list selection; they are the arrow keys of a terminal. */
const LIST_STEP_LETTERS: ReadonlySet<string> = new Set(["n", "p"]);

/** The editing chords of a text field: delete word, line, character, kill and yank. Ctrl only, and only in a field. */
const FIELD_EDIT_LETTERS: ReadonlySet<string> = new Set(["a", "b", "d", "e", "f", "h", "k", "u", "w", "y"]);

function keyName(event: Pick<KeyEventLike, "name" | "key">): string {
  return (event.name ?? event.key ?? "").toLowerCase();
}

function isCommandKey(event: RepeatKey, name: string): boolean {
  if (event.ctrl || event.meta || event.super === true) return true;
  return name === "escape" || name === "esc" || name === "contextmenu" || name === "menu" || /^f([1-9]|1\d|2[0-4])$/.test(name);
}

/** Whether a held key keeps firing: true for typing and moving, false for a command that should run once. */
export function mayRepeat(event: RepeatKey): boolean {
  const name = keyName(event);
  if (!isCommandKey(event, name)) return true;
  if (REPEATING_KEY_NAMES.has(name)) return true;
  const ctrlOnly = event.ctrl && !event.meta && event.super !== true && !event.alt && !event.shift;
  if (!ctrlOnly) return false;
  if (LIST_STEP_LETTERS.has(name)) return true;
  return event.targetEditable === true && FIELD_EDIT_LETTERS.has(name);
}

/**
 * Plain keys a pane's footer hint keeps repeating: moving, paging, stepping and
 * zooming (`[` `]` `<` `>` `+` `-` `=`, and the vim letters). Any other hint key
 * (an add, an export, a pause on Space) runs once per press: the footer drops
 * its repeats, so a held key never opens a dialog or writes a file again.
 */
const REPEATING_HINT_KEYS: ReadonlySet<string> = new Set([
  ...REPEATING_KEY_NAMES,
  "j", "k", "h", "l",
  "[", "]", "<", ">", "+", "-", "=", "_",
]);

/** Whether a held key keeps pressing the footer hint it names. Chords follow `mayRepeat`; plain keys must be a movement or zoom key. */
export function hintMayRepeat(event: RepeatKey): boolean {
  const name = keyName(event);
  return isCommandKey(event, name) ? mayRepeat(event) : REPEATING_HINT_KEYS.has(name);
}

/** The key and its modifiers, to tell whether a repeat belongs to the press that came before it. */
export function keySignature(event: RepeatKey): string {
  const modifiers = [event.ctrl, event.alt, event.meta, event.shift, event.super === true].map(Number).join("");
  return `${modifiers}:${keyName(event)}`;
}
