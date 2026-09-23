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

export function isNamedKey(key: string): boolean {
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

export interface FormatKeyChordOptions {
  /** What `CmdOrCtrl` reads as on this host. */
  primaryModifier: PrimaryModifier;
  /** The label for an explicit Command chord; Windows and Linux desktops call it Super. */
  cmdLabel?: string;
}

/** The label users see: `Ctrl+Shift+F` in a terminal, `Cmd+Shift+F` on a Mac. */
export function formatKeyChord(chord: KeyChord, options: FormatKeyChordOptions): string {
  const cmdLabel = options.cmdLabel ?? "Cmd";
  const parts: string[] = [];
  if (chord.primary) parts.push(options.primaryModifier === "cmd" ? cmdLabel : "Ctrl");
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.cmd) parts.push(cmdLabel);
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  const named = NAMED_KEY_BY_ALIAS.get(chord.key);
  parts.push(named ? named.label : isLetter(chord.key) ? chord.key.toUpperCase() : chord.key);
  return parts.join("+");
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
