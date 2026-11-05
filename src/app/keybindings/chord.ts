/**
 * One key chord: the key plus the modifiers held with it.
 *
 * Bindings are written in the accelerator grammar the menus already use
 * (`CmdOrCtrl+Shift+F`, `Alt+1`, `F5`, `` ` ``). `CmdOrCtrl` is the primary
 * modifier: Control in a terminal, Command on the macOS desktop and web hosts,
 * and either one is accepted when matching, which is how every built-in chord
 * behaved before bindings became configurable.
 */
export interface KeyChord {
  /**
   * Lowercase key: a single character, a named key such as `tab` or `f5`, or
   * `digit`, the 1-9 family used by layout switching.
   */
  key: string;
  /** Control only. Exclusive with `primary`. */
  ctrl: boolean;
  /** Command (macOS) or Super/Win only. Exclusive with `primary`. */
  cmd: boolean;
  /** Control or Command, whichever the host reports. */
  primary: boolean;
  alt: boolean;
  shift: boolean;
}

export interface KeyChordEventLike {
  key?: string;
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  super?: boolean;
}

export type PrimaryModifier = "ctrl" | "cmd";

const MODIFIER_TOKENS: Record<string, keyof Omit<KeyChord, "key">> = {
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "cmd",
  command: "cmd",
  super: "cmd",
  meta: "cmd",
  win: "cmd",
  cmdorctrl: "primary",
  "cmd/ctrl": "primary",
  commandorcontrol: "primary",
  mod: "primary",
  primary: "primary",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/**
 * Named keys, the event names each host reports for them, the label shown, and
 * the config spelling when it differs from the label.
 */
const NAMED_KEYS: Array<{ key: string; aliases: string[]; label: string; spelling?: string }> = [
  { key: "tab", aliases: ["tab"], label: "Tab" },
  { key: "return", aliases: ["return", "enter"], label: "Enter" },
  { key: "escape", aliases: ["escape", "esc"], label: "Esc", spelling: "Escape" },
  { key: "space", aliases: ["space", " "], label: "Space" },
  { key: "backspace", aliases: ["backspace"], label: "Backspace" },
  { key: "delete", aliases: ["delete", "del"], label: "Delete" },
  { key: "insert", aliases: ["insert", "ins"], label: "Insert" },
  { key: "up", aliases: ["up", "arrowup"], label: "Up" },
  { key: "down", aliases: ["down", "arrowdown"], label: "Down" },
  { key: "left", aliases: ["left", "arrowleft"], label: "Left" },
  { key: "right", aliases: ["right", "arrowright"], label: "Right" },
  { key: "home", aliases: ["home"], label: "Home" },
  { key: "end", aliases: ["end"], label: "End" },
  { key: "pageup", aliases: ["pageup", "pgup"], label: "PageUp" },
  { key: "pagedown", aliases: ["pagedown", "pgdn", "pgdown"], label: "PageDown" },
  { key: "digit", aliases: ["digit", "1-9"], label: "1-9", spelling: "Digit" },
  // The context-menu key beside the right Alt on Windows and Linux keyboards.
  { key: "contextmenu", aliases: ["contextmenu", "menu", "apps"], label: "Menu", spelling: "ContextMenu" },
  ...Array.from({ length: 24 }, (_, index) => ({
    key: `f${index + 1}`,
    aliases: [`f${index + 1}`],
    label: `F${index + 1}`,
  })),
];

const NAMED_KEY_BY_ALIAS = new Map<string, typeof NAMED_KEYS[number]>();
for (const named of NAMED_KEYS) {
  for (const alias of named.aliases) NAMED_KEY_BY_ALIAS.set(alias, named);
}

/** Spelled-out punctuation, for people who would rather not quote a backtick in JSON. */
const SYMBOL_WORDS: Record<string, string> = {
  plus: "+",
  minus: "-",
  comma: ",",
  period: ".",
  dot: ".",
  backtick: "`",
  grave: "`",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  equals: "=",
  equal: "=",
  question: "?",
};

/** Event names that are a modifier on its own, never a chord. */
const MODIFIER_ONLY_EVENT_NAMES = new Set([
  "", "shift", "ctrl", "control", "alt", "option", "meta", "super", "cmd", "command", "capslock", "fn",
]);

function isNamedKey(key: string): boolean {
  return NAMED_KEY_BY_ALIAS.get(key)?.key === key;
}

function isLetter(key: string): boolean {
  return key.length === 1 && /[a-z]/i.test(key);
}

function emptyChord(): KeyChord {
  return { key: "", ctrl: false, cmd: false, primary: false, alt: false, shift: false };
}

/**
 * Parses `Ctrl+Shift+P` style text. Returns null for text that names no key or
 * mixes `Ctrl` or `Cmd` with `CmdOrCtrl`. Case-insensitive throughout, and an
 * uppercase letter means the letter, not Shift: `Ctrl+K` is Control and k.
 */
export function parseKeyChord(text: string): KeyChord | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // "Ctrl++" and a bare "+" name the plus key; "Ctrl+" names nothing.
  const tokens = trimmed === "+" || trimmed.endsWith("++")
    ? [...trimmed.slice(0, -1).split("+").filter((token) => token.length > 0), "+"]
    : trimmed.split("+");
  if (tokens.length === 0 || tokens.some((token) => token.trim().length === 0)) return null;

  const chord = emptyChord();
  const keyToken = tokens[tokens.length - 1]!.trim();
  for (const token of tokens.slice(0, -1)) {
    const modifier = MODIFIER_TOKENS[token.trim().toLowerCase()];
    if (!modifier) return null;
    chord[modifier] = true;
  }
  if (chord.primary && (chord.ctrl || chord.cmd)) return null;

  const lowered = keyToken.toLowerCase();
  const named = NAMED_KEY_BY_ALIAS.get(lowered);
  if (named) {
    chord.key = named.key;
  } else if (SYMBOL_WORDS[lowered]) {
    chord.key = SYMBOL_WORDS[lowered]!;
  } else if ([...keyToken].length === 1) {
    chord.key = isLetter(keyToken) ? lowered : keyToken;
  } else {
    return null;
  }
  return chord;
}

/** Canonical config spelling for a chord, the inverse of {@link parseKeyChord}. */
export function serializeKeyChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.primary) parts.push("CmdOrCtrl");
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.cmd) parts.push("Cmd");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  const named = NAMED_KEY_BY_ALIAS.get(chord.key);
  parts.push(named ? named.spelling ?? named.label : isLetter(chord.key) ? chord.key.toUpperCase() : chord.key);
  return parts.join("+");
}

/**
 * How a host writes keys. `text` spells them out joined by `+` (`Ctrl+Shift+F`),
 * as terminals, Windows and Linux do; `mac` is Apple's notation: the modifier
 * symbols in the order its menus use, Control, Option, Shift, Command, then the
 * key, with nothing between (`⇧⌘F`, `⌥↩`).
 */
export type KeyNotation = "text" | "mac";

export interface FormatKeyChordOptions {
  /** What `CmdOrCtrl` reads as on this host. */
  primaryModifier: PrimaryModifier;
  /** The label for an explicit Command chord; Windows and Linux desktops call it Super. */
  cmdLabel?: string;
  notation?: KeyNotation;
  /**
   * As short as a tab label allows, in text notation: `^` for Control and `⇧`
   * for Shift (`^2`, `^⇧F`). Mac notation is already that short.
   */
  compact?: boolean;
}

const MAC_MODIFIER_SYMBOLS = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" } as const;

/**
 * Keys a Mac names by the symbol its menus print. The rest keep their names:
 * `Esc`, `Space`, `Home` and `PageUp` read better spelled out than as ⎋, ↖ or ⇞.
 */
const MAC_KEY_SYMBOLS: Record<string, string> = {
  return: "↩",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌦",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

type ChordModifiers = Pick<KeyChord, "ctrl" | "cmd" | "primary" | "alt" | "shift">;

function modifierPrefix(modifiers: ChordModifiers, options: FormatKeyChordOptions): string {
  const ctrl = modifiers.ctrl || (modifiers.primary && options.primaryModifier === "ctrl");
  const cmd = modifiers.cmd || (modifiers.primary && options.primaryModifier === "cmd");
  if (options.notation === "mac") {
    return (ctrl ? MAC_MODIFIER_SYMBOLS.ctrl : "")
      + (modifiers.alt ? MAC_MODIFIER_SYMBOLS.alt : "")
      + (modifiers.shift ? MAC_MODIFIER_SYMBOLS.shift : "")
      + (cmd ? MAC_MODIFIER_SYMBOLS.cmd : "");
  }
  const cmdLabel = options.cmdLabel ?? "Cmd";
  if (options.compact) {
    return (ctrl ? "^" : "") + (modifiers.alt ? "Alt+" : "") + (modifiers.shift ? "⇧" : "") + (cmd ? `${cmdLabel}+` : "");
  }
  // The primary modifier leads, as it always has: `Cmd+Ctrl+K` for a chord bound to both.
  const parts: string[] = [];
  if (modifiers.primary) parts.push(options.primaryModifier === "cmd" ? cmdLabel : "Ctrl");
  if (modifiers.ctrl) parts.push("Ctrl");
  if (modifiers.cmd) parts.push(cmdLabel);
  if (modifiers.alt) parts.push("Alt");
  if (modifiers.shift) parts.push("Shift");
  return parts.map((part) => `${part}+`).join("");
}

/**
 * The label users see: `Ctrl+Shift+F` in a terminal and on Windows and Linux,
 * `⇧⌘F` on a Mac.
 */
export function formatKeyChord(chord: KeyChord, options: FormatKeyChordOptions): string {
  const named = NAMED_KEY_BY_ALIAS.get(chord.key);
  const key = options.notation === "mac" && MAC_KEY_SYMBOLS[chord.key]
    ? MAC_KEY_SYMBOLS[chord.key]!
    : named ? named.label : isLetter(chord.key) ? chord.key.toUpperCase() : chord.key;
  return modifierPrefix(chord, options) + key;
}

/** Leading modifiers of a written shortcut, in the grammar parseKeyChord reads: `Ctrl+`, `Cmd/Ctrl+Shift+`, `Alt+`. */
const WRITTEN_MODIFIERS = new RegExp(`^(?:(?:${Object.keys(MODIFIER_TOKENS).join("|")})\\+)+`, "i");

/** A key written alone in Mac notation takes its symbol only when spelled as a label is (`Enter`, `Up`), never a code such as `UP`. */
const TITLE_CASE = /^[A-Z][a-z]+$/;

function macWrittenKey(written: string, modified: boolean): string {
  const named = NAMED_KEY_BY_ALIAS.get(written.toLowerCase());
  const symbol = named ? MAC_KEY_SYMBOLS[named.key] : undefined;
  if (symbol && (modified || TITLE_CASE.test(written))) return symbol;
  return modified && isLetter(written) ? written.toUpperCase() : written;
}

/**
 * A shortcut written as text, as panes, menus and help rows name keys
 * (`Ctrl+S`, `Shift+Enter`, `CmdOrCtrl+F`, `Shift+Left/Right`, `Ctrl+P/N`,
 * `Alt+Drag`, `Up/Down`), in the host's notation. Text notation only says
 * which modifier `CmdOrCtrl` is and leaves the rest as written. Mac notation
 * writes the modifiers as symbols and the keys that have one as theirs
 * (`⌃S`, `⇧↩`, `⌘F`, `⇧←/→`, `⌃P/N`, `⌥Drag`, `↑/↓`); text that names no
 * modifier or key, such as `a`, `G`, `DES` or `Drag`, and a label already in
 * Mac notation come back unchanged.
 */
export function formatShortcutText(text: string, options: FormatKeyChordOptions): string {
  if (options.notation !== "mac") {
    const primary = options.primaryModifier === "cmd" ? options.cmdLabel ?? "Cmd" : "Ctrl";
    return text.replace(/Cmd\/Ctrl|CmdOrCtrl/g, primary);
  }
  // A modifier named alone ("Shift pans further") is its symbol.
  const lone = MODIFIER_TOKENS[text.toLowerCase()];
  if (lone && lone !== "primary" && TITLE_CASE.test(text)) return MAC_MODIFIER_SYMBOLS[lone];
  const prefix = WRITTEN_MODIFIERS.exec(text)?.[0] ?? "";
  const rest = text.slice(prefix.length);
  if (!rest) return text;
  const modifiers: ChordModifiers = { ctrl: false, cmd: false, primary: false, alt: false, shift: false };
  for (const token of prefix.split(/\+/).filter(Boolean)) {
    const modifier = MODIFIER_TOKENS[token.toLowerCase()];
    if (modifier) modifiers[modifier] = true;
  }
  // `Left/Right` is either key; a lone `/` is the slash key, and `+/-` is plus or minus.
  const pieces = rest.split("/");
  const keys = pieces.every((piece) => piece.length > 0) ? pieces : [rest];
  return modifierPrefix(modifiers, options) + keys.map((key) => macWrittenKey(key, prefix.length > 0)).join("/");
}

/** `aria-keyshortcuts` names, from the UI Events key values, for keys written out or as Mac symbols. */
const ARIA_KEYS: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  ctrl: "Control",
  cmd: "Meta",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  "⌃": "Control",
  "⌥": "Alt",
  "⇧": "Shift",
  "⌘": "Meta",
  "↩": "Enter",
  "⇥": "Tab",
  "⌫": "Backspace",
  "⌦": "Delete",
  "←": "ArrowLeft",
  "→": "ArrowRight",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
};

/** Mac modifier symbols lead a label with no `+` between them: ⇧⌘↩ is Shift, Meta, Enter. */
const MAC_MODIFIER_RUN = /^[⌃⌥⇧⌘]+/;

/**
 * The `aria-keyshortcuts` value for one key chord, such as "Shift+Enter" or
 * "Escape", written out or as a Mac label (⇧⌘↩).
 */
export function ariaKeyShortcut(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const symbols = MAC_MODIFIER_RUN.exec(key)?.[0] ?? "";
  const parts = symbols && !key.includes("+")
    ? [...symbols, key.slice(symbols.length)]
    : key.split("+");
  return parts.map((part) => ARIA_KEYS[part.trim().toLowerCase()] ?? part.trim()).join("+");
}

export function keyChordsEqual(left: KeyChord, right: KeyChord): boolean {
  return left.key === right.key
    && left.ctrl === right.ctrl
    && left.cmd === right.cmd
    && left.primary === right.primary
    && left.alt === right.alt
    && left.shift === right.shift;
}

/** True when the chord could be typed into a text field as-is, so it must not double as a global key. */
export function isTypingChord(chord: KeyChord): boolean {
  if (chord.ctrl || chord.cmd || chord.primary || chord.alt) return false;
  if (chord.key === "digit") return true;
  return !isNamedKey(chord.key) || ["space", "return", "tab", "backspace", "delete"].includes(chord.key);
}

function eventKeyName(event: KeyChordEventLike): string {
  return event.name ?? event.key ?? "";
}

function eventHasCmd(event: KeyChordEventLike): boolean {
  return event.meta === true || event.super === true;
}

/**
 * Whether the event is this chord. `primary` accepts Control or Command. Shift
 * matters for letters and named keys, and a letter that arrives uppercase
 * counts as shifted, which is how some terminals report Shift+R. Punctuation
 * ignores Shift, because reaching `?` or `` ` `` needs Shift on many layouts
 * and the host has already resolved which character came out.
 */
export function matchesKeyChord(chord: KeyChord, event: KeyChordEventLike): boolean {
  const ctrl = event.ctrl === true;
  const cmd = eventHasCmd(event);
  if (chord.primary) {
    if (!ctrl && !cmd) return false;
  } else if (chord.ctrl !== ctrl || chord.cmd !== cmd) {
    return false;
  }
  if (chord.alt !== (event.alt === true)) return false;

  const raw = eventKeyName(event);
  const shift = event.shift === true;
  if (chord.key === "digit") {
    return /^[1-9]$/.test(raw) && chord.shift === shift;
  }
  const named = NAMED_KEY_BY_ALIAS.get(chord.key);
  if (named) {
    return named.aliases.includes(raw.toLowerCase()) && chord.shift === shift;
  }
  if (isLetter(chord.key)) {
    if (raw.toLowerCase() !== chord.key) return false;
    const shifted = shift || (raw.length === 1 && raw !== raw.toLowerCase());
    return chord.shift === shifted;
  }
  if (raw === chord.key || event.sequence === chord.key) return true;
  // Terminals without the kitty protocol report a US-layout "?" as Shift+/.
  return chord.key === "?" && raw === "/" && shift;
}

/** The digit an event pressed, for chords on the `digit` family. */
export function keyChordDigit(event: KeyChordEventLike): number | null {
  const raw = eventKeyName(event);
  return /^[1-9]$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

/**
 * The chord an event represents, for capture. Returns null for a bare modifier.
 * The host's own primary modifier is recorded as `CmdOrCtrl`, so a chord bound
 * from the terminal still fires under Command in the desktop app on the same
 * machine; the other one stays explicit.
 */
export function keyChordFromEvent(event: KeyChordEventLike, primaryModifier: PrimaryModifier): KeyChord | null {
  const raw = eventKeyName(event);
  if (MODIFIER_ONLY_EVENT_NAMES.has(raw.toLowerCase())) return null;

  const chord = emptyChord();
  const ctrl = event.ctrl === true;
  const cmd = eventHasCmd(event);
  if (ctrl && cmd) {
    chord.ctrl = true;
    chord.cmd = true;
  } else if (ctrl) {
    if (primaryModifier === "ctrl") chord.primary = true;
    else chord.ctrl = true;
  } else if (cmd) {
    if (primaryModifier === "cmd") chord.primary = true;
    else chord.cmd = true;
  }
  chord.alt = event.alt === true;

  const named = NAMED_KEY_BY_ALIAS.get(raw.toLowerCase());
  if (named && named.key !== "digit") {
    chord.key = named.key;
    chord.shift = event.shift === true;
    return chord;
  }
  if ([...raw].length !== 1) return null;
  if (isLetter(raw)) {
    chord.key = raw.toLowerCase();
    chord.shift = event.shift === true || raw !== raw.toLowerCase();
    return chord;
  }
  chord.key = raw;
  return chord;
}
