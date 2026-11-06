import { formatShortcutForHost, keyNotationFor } from "../../app/keybindings/labels";
import { displayWidth } from "../../utils/format";

/**
 * What a key hint says, read three ways from one definition. A footer hint
 * writes what the terminal shows after its key: `{ key: "s", label: "eries" }`
 * is `[s]eries`. The desktop and the web show the key in a keycap before the
 * whole word (`s` series), never inside it, and the pane menu names it
 * ("Series"). This file turns the terminal's label into those words.
 */
export interface KeyHintSource {
  key: string;
  /** What the terminal writes after `[key]`. */
  label: string;
  /** The action's name in the pane menu, when it is not the hint read as words. */
  title?: string;
  id?: string;
}

/** Letters and digits only, lower case: "re-arm" is `rearm`, "Re-arm" too. */
function letters(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** One reads as the start of the other, for names of three letters or more. */
function sameName(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3) return a.length > 0 && a === b;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * The hint's words, without the key: `[s]eries` is "series", `[x] remove`
 * "remove", `[Esc]tabs` "tabs", `[t]BO` "TBO".
 *
 * - A label that starts with a space, and any key that is not a single letter
 *   (`Enter`, `Esc`, `Ctrl+S`, `/`, `0`), is followed by words of its own.
 * - A letter key starts its word, and the label is the rest of it (`[a]dd`),
 *   unless the hint's `title` or `id` names the label alone: `{ key: "m",
 *   label: "re-arm", title: "Re-arm" }` and `{ id: "stop", key: "x", label:
 *   "stop" }` are words of their own, and so is a label that undoes what the
 *   id names (`{ id: "mute", key: "m", label: "unmute" }`). A title with the
 *   key and the label inside one of its words puts the key inside that word:
 *   `{ key: "x", label: "port all", title: "Export All" }` is "export all".
 * - With neither, a label that starts with the key's own letter (`[u]upgrade`)
 *   or with a capital (`[d]Broker`) is a word of its own, as the pane menu has
 *   always read it; an all-capital label is the rest of a code (`[t]BO`).
 */
export function keyHintWords(hint: KeyHintSource): string {
  const { key, label } = hint;
  const words = label.trim();
  if (!words) return "";
  if (/^\s/.test(label) || !/^\p{L}$/u.test(key)) return words;
  const names = [hint.title, hint.id].filter((name): name is string => !!name).map(letters);
  const joined = letters(key + label);
  if (names.some((name) => sameName(joined, name))) return `${key}${label}`;
  const own = letters(label);
  if (names.some((name) => sameName(own, name) || (name.length >= 3 && own === `un${name}`))) return words;
  const inside = hint.title ? keyInsideTitle(hint.title, key, label) : null;
  if (inside) return inside;
  if (label.toLowerCase().startsWith(key.toLowerCase())) return words;
  if (/^\p{Lu}+$/u.test(label)) return `${key.toUpperCase()}${label}`;
  if (/^\p{Lu}/u.test(label)) return words;
  return /^\p{L}/u.test(label) ? `${key}${label}` : words;
}

/**
 * "export all" for `[x]port all` titled "Export All", "expand" for `[x]pand`
 * titled "Expand Row": the title's word that has the key, then the label,
 * after its first letter.
 */
function keyInsideTitle(title: string, key: string, label: string): string | null {
  const at = title.toLowerCase().indexOf(`${key}${label}`.toLowerCase());
  if (at < 1 || !/\p{L}/u.test(title.charAt(at - 1))) return null;
  let start = at;
  while (start > 0 && /\p{L}/u.test(title.charAt(start - 1))) start -= 1;
  const head = title.slice(start, at);
  const lowered = start === 0 || /\s/.test(title.charAt(start - 1)) ? head.toLowerCase() : head;
  return `${lowered}${key}${label}`;
}

/** A hint's name in a menu: its title, or its words with a capital (`[a]dd` is "Add"). */
export function keyHintTitle(hint: KeyHintSource): string {
  if (hint.title) return hint.title;
  const words = keyHintWords(hint);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Keys a keycap draws as the symbol printed on the key, off a Mac; the rest keep their name. */
const KEY_SYMBOLS: Record<string, string> = {
  enter: "↵",
  return: "↵",
  shift: "⇧",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  escape: "Esc",
};

/**
 * What a keycap shows for `key`. On a Mac, Apple's notation
 * (formatShortcutForHost): "Shift+Enter" is ⇧↩ and "Ctrl+G" ⌃G. Elsewhere
 * "Shift+Enter" reads ⇧↵ and "Enter" ↵, and "Ctrl+G", "Esc" and "y" stay as
 * they are.
 */
export function keycapText(key: string): string {
  if (keyNotationFor("platform") === "mac") return formatShortcutForHost(key, "platform");
  return key
    .split("+")
    .map((part) => KEY_SYMBOLS[part.trim().toLowerCase()] ?? part.trim())
    .join("+")
    .replaceAll("⇧+", "⇧");
}

/*
 * A key hint's size on the desktop and the web, in grid cells, from
 * styles.css. The text scales with the font size (FONT- and FONT+) and so
 * does the cell, 8px at the default 12px text, so text measures the same
 * number of cells at every size. Monospace fonts advance about 0.6em a
 * character (SF Mono, Menlo, DejaVu Sans Mono; Consolas less): 0.9 of a cell
 * at the text size and 0.75 at the keycap's caption size. These allow a
 * little more, as a hint must never be wider than the room it was given. A
 * symbol (⌘, ↵, ←) may come from a wider fallback font, so it counts as a
 * whole em of the caption. The spacing does not scale: the keycap's 4px
 * either side and 14px at least, the 4px before the words and the 12px
 * between two hints are pixels, so they take more cells at a small size
 * (6.67px cells at 10px text) and fewer at a large one.
 */
const TEXT_CHAR_CELLS = 0.92;
const CAPTION_CHAR_CELLS = 0.77;
const CAPTION_SYMBOL_CELLS = 10 / 8;
const KEYCAP_PADDING_PX = 8;
const KEYCAP_MIN_PX = 14;
const KEYCAP_WORD_GAP_PX = 4;
/** Pixels between two key hints on the desktop and the web (`--gloom-space-md`). */
export const KEY_HINT_GAP_PX = 12;
/** The grid's cell at the default text size; `cellPx` is the live one (useUiCapabilities().cellWidthPx). */
const DEFAULT_CELL_PX = 8;

function keycapPx(keycap: string, cellPx: number): number {
  let glyphCells = 0;
  for (const char of keycap) glyphCells += /[\x20-\x7e]/.test(char) ? CAPTION_CHAR_CELLS : CAPTION_SYMBOL_CELLS;
  return Math.max(KEYCAP_MIN_PX, glyphCells * cellPx + KEYCAP_PADDING_PX);
}

/**
 * Cells one key hint takes on the desktop and the web, on a grid of `cellPx`
 * cells: the keycap of `keycap`, then `words`.
 */
export function keyHintCells(keycap: string, words: string, cellPx = DEFAULT_CELL_PX): number {
  const px = keycapPx(keycap, cellPx) + (words ? KEYCAP_WORD_GAP_PX + displayWidth(words) * TEXT_CHAR_CELLS * cellPx : 0);
  return px / cellPx;
}
