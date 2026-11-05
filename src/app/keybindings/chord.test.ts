import { describe, expect, test } from "bun:test";
import {
  ariaKeyShortcut,
  formatKeyChord,
  formatShortcutText,
  isTypingChord,
  keyChordFromEvent,
  matchesKeyChord,
  parseKeyChord,
  serializeKeyChord,
} from "./chord";

describe("parseKeyChord", () => {
  test("reads the accelerator grammar case-insensitively and round-trips", () => {
    expect(parseKeyChord("CmdOrCtrl+Shift+F")).toEqual({ key: "f", ctrl: false, cmd: false, primary: true, alt: false, shift: true });
    expect(parseKeyChord("ctrl+p")).toEqual({ key: "p", ctrl: true, cmd: false, primary: false, alt: false, shift: false });
    expect(parseKeyChord("`")).toEqual({ key: "`", ctrl: false, cmd: false, primary: false, alt: false, shift: false });
    expect(parseKeyChord("Alt+1")).toMatchObject({ key: "1", alt: true });
    expect(parseKeyChord("F5")).toMatchObject({ key: "f5" });
    expect(parseKeyChord("Ctrl++")).toMatchObject({ key: "+", ctrl: true });
    expect(parseKeyChord("CmdOrCtrl+,")).toMatchObject({ key: ",", primary: true });
    expect(parseKeyChord("Option+Backtick")).toMatchObject({ key: "`", alt: true });
    expect(parseKeyChord("CmdOrCtrl+Digit")).toMatchObject({ key: "digit", primary: true });
    for (const text of ["CmdOrCtrl+Shift+F", "Ctrl+P", "`", "Alt+1", "F5", "Shift+Tab", "CmdOrCtrl+Digit", "Escape"]) {
      expect(serializeKeyChord(parseKeyChord(text)!)).toBe(text);
    }
  });

  test("an uppercase letter is the letter, not Shift", () => {
    expect(parseKeyChord("Ctrl+K")).toMatchObject({ key: "k", shift: false });
    expect(parseKeyChord("Shift+R")).toMatchObject({ key: "r", shift: true });
  });

  test("rejects text that names no key or mixes explicit and primary modifiers", () => {
    expect(parseKeyChord("")).toBeNull();
    expect(parseKeyChord("Ctrl+")).toBeNull();
    expect(parseKeyChord("Ctrl+Shift")).toBeNull();
    expect(parseKeyChord("Hyper+K")).toBeNull();
    expect(parseKeyChord("Ctrl+CmdOrCtrl+K")).toBeNull();
    expect(parseKeyChord("Ctrl+Bogus")).toBeNull();
  });
});

describe("formatKeyChord", () => {
  test("names the primary modifier for the host", () => {
    const chord = parseKeyChord("CmdOrCtrl+Shift+F")!;
    expect(formatKeyChord(chord, { primaryModifier: "ctrl" })).toBe("Ctrl+Shift+F");
    expect(formatKeyChord(chord, { primaryModifier: "cmd" })).toBe("Cmd+Shift+F");
    expect(formatKeyChord(parseKeyChord("Escape")!, { primaryModifier: "ctrl" })).toBe("Esc");
    expect(formatKeyChord(parseKeyChord("CmdOrCtrl+Digit")!, { primaryModifier: "cmd" })).toBe("Cmd+1-9");
  });

  test("Mac notation writes Apple's symbols in Control, Option, Shift, Command order, then the key", () => {
    const mac = { primaryModifier: "cmd", notation: "mac" } as const;
    expect(formatKeyChord(parseKeyChord("CmdOrCtrl+Shift+F")!, mac)).toBe("⇧⌘F");
    expect(formatKeyChord(parseKeyChord("Cmd+Shift+Alt+Ctrl+K")!, mac)).toBe("⌃⌥⇧⌘K");
    expect(formatKeyChord(parseKeyChord("Alt+Enter")!, mac)).toBe("⌥↩");
    expect(formatKeyChord(parseKeyChord("Shift+Tab")!, mac)).toBe("⇧⇥");
    expect(formatKeyChord(parseKeyChord("CmdOrCtrl+Digit")!, mac)).toBe("⌘1-9");
    expect(formatKeyChord(parseKeyChord("Escape")!, mac)).toBe("Esc");
    expect(formatKeyChord(parseKeyChord("`")!, mac)).toBe("`");
  });
});

describe("formatShortcutText", () => {
  const mac = { primaryModifier: "cmd", notation: "mac" } as const;
  // Written as panes, menus and help rows name keys, and what a Mac shows for each.
  const written: Array<[string, string]> = [
    ["Ctrl+S", "⌃S"],
    ["Shift+Enter", "⇧↩"],
    ["CmdOrCtrl+F", "⌘F"],
    ["Cmd/Ctrl+Shift+D", "⇧⌘D"],
    ["Alt+Shift+Ctrl+x", "⌃⌥⇧X"],
    ["Shift+Left/Right", "⇧←/→"],
    ["Ctrl+P/N", "⌃P/N"],
    ["Ctrl+Home/End", "⌃Home/End"],
    ["Alt+Drag", "⌥Drag"],
    ["Ctrl++", "⌃+"],
    ["Shift+/", "⇧/"],
    ["Up/Down", "↑/↓"],
    ["Enter", "↩"],
    ["Backspace", "⌫"],
    ["Shift", "⇧"],
    ["Esc", "Esc"],
    ["PageUp/PageDown", "PageUp/PageDown"],
    ["+/-", "+/-"],
    ["1-9", "1-9"],
    ["a", "a"],
    ["G", "G"],
    ["Drag", "Drag"],
    // Function codes are not keys, even where one spells a key's name.
    ["DES", "DES"],
    ["UP", "UP"],
  ];

  test("a Mac writes modifiers and the keys that have one as symbols", () => {
    for (const [text, label] of written) expect(formatShortcutText(text, mac)).toBe(label);
  });

  test("a label already in Mac notation comes back as it is", () => {
    for (const [, label] of written) expect(formatShortcutText(label, mac)).toBe(label);
  });

  test("text notation leaves every key as written and only resolves CmdOrCtrl", () => {
    for (const primaryModifier of ["ctrl", "cmd"] as const) {
      for (const [text] of written) {
        if (/CmdOrCtrl|Cmd\/Ctrl/.test(text)) continue;
        expect(formatShortcutText(text, { primaryModifier })).toBe(text);
      }
    }
    expect(formatShortcutText("CmdOrCtrl+F", { primaryModifier: "ctrl" })).toBe("Ctrl+F");
    expect(formatShortcutText("Cmd/Ctrl+Shift+D", { primaryModifier: "ctrl" })).toBe("Ctrl+Shift+D");
  });
});

describe("ariaKeyShortcut", () => {
  test("reads keys written out and Mac labels as UI Events key names", () => {
    expect(ariaKeyShortcut("Shift+Enter")).toBe("Shift+Enter");
    expect(ariaKeyShortcut("Cmd+K")).toBe("Meta+K");
    expect(ariaKeyShortcut("⇧⌘↩")).toBe("Shift+Meta+Enter");
    expect(ariaKeyShortcut("⌃G")).toBe("Control+G");
    expect(ariaKeyShortcut("Esc")).toBe("Escape");
    expect(ariaKeyShortcut("")).toBeUndefined();
  });
});

describe("matchesKeyChord", () => {
  const base = { ctrl: false, shift: false, alt: false, meta: false, super: false };

  test("primary accepts Control, Command and the kitty super modifier", () => {
    const chord = parseKeyChord("CmdOrCtrl+K")!;
    expect(matchesKeyChord(chord, { ...base, name: "k", ctrl: true })).toBe(true);
    expect(matchesKeyChord(chord, { ...base, name: "k", meta: true })).toBe(true);
    expect(matchesKeyChord(chord, { ...base, name: "k", super: true })).toBe(true);
    expect(matchesKeyChord(chord, { ...base, name: "k" })).toBe(false);
    expect(matchesKeyChord(chord, { ...base, name: "k", ctrl: true, alt: true })).toBe(false);
  });

  test("explicit Control does not accept Command", () => {
    const chord = parseKeyChord("Ctrl+P")!;
    expect(matchesKeyChord(chord, { ...base, name: "p", ctrl: true })).toBe(true);
    expect(matchesKeyChord(chord, { ...base, name: "p", meta: true })).toBe(false);
  });

  test("letters honour Shift, including an uppercase name from the terminal", () => {
    const shifted = parseKeyChord("Shift+R")!;
    const plain = parseKeyChord("R")!;
    expect(matchesKeyChord(shifted, { ...base, name: "R" })).toBe(true);
    expect(matchesKeyChord(shifted, { ...base, name: "r", shift: true })).toBe(true);
    expect(matchesKeyChord(shifted, { ...base, name: "r" })).toBe(false);
    expect(matchesKeyChord(plain, { ...base, name: "r" })).toBe(true);
    expect(matchesKeyChord(plain, { ...base, name: "R" })).toBe(false);
    expect(matchesKeyChord(plain, { ...base, name: "r", ctrl: true })).toBe(false);
  });

  test("punctuation ignores Shift and accepts the US-layout slash for question mark", () => {
    const help = parseKeyChord("?")!;
    expect(matchesKeyChord(help, { ...base, name: "?", shift: true })).toBe(true);
    expect(matchesKeyChord(help, { ...base, name: "?" })).toBe(true);
    expect(matchesKeyChord(help, { ...base, name: "/", shift: true })).toBe(true);
    expect(matchesKeyChord(help, { ...base, name: "/", shift: true, alt: true })).toBe(false);
    expect(matchesKeyChord(parseKeyChord("`")!, { ...base, name: "`" })).toBe(true);
  });

  test("named keys and the digit family", () => {
    expect(matchesKeyChord(parseKeyChord("Shift+Tab")!, { ...base, name: "tab", shift: true })).toBe(true);
    expect(matchesKeyChord(parseKeyChord("Tab")!, { ...base, name: "tab", shift: true })).toBe(false);
    expect(matchesKeyChord(parseKeyChord("Enter")!, { ...base, name: "return" })).toBe(true);
    expect(matchesKeyChord(parseKeyChord("CmdOrCtrl+Digit")!, { ...base, name: "3", super: true })).toBe(true);
    expect(matchesKeyChord(parseKeyChord("CmdOrCtrl+Digit")!, { ...base, name: "0", ctrl: true })).toBe(false);
    expect(matchesKeyChord(parseKeyChord("CmdOrCtrl+Digit")!, { ...base, name: "2", alt: true })).toBe(false);
  });
});

describe("keyChordFromEvent", () => {
  const base = { ctrl: false, shift: false, alt: false, meta: false, super: false };

  test("records the host's own modifier as CmdOrCtrl and the other one explicitly", () => {
    expect(serializeKeyChord(keyChordFromEvent({ ...base, name: "t", ctrl: true }, "ctrl")!)).toBe("CmdOrCtrl+T");
    expect(serializeKeyChord(keyChordFromEvent({ ...base, name: "t", super: true }, "ctrl")!)).toBe("Cmd+T");
    expect(serializeKeyChord(keyChordFromEvent({ ...base, name: "t", meta: true }, "cmd")!)).toBe("CmdOrCtrl+T");
    expect(serializeKeyChord(keyChordFromEvent({ ...base, name: "t", ctrl: true }, "cmd")!)).toBe("Ctrl+T");
    expect(serializeKeyChord(keyChordFromEvent({ ...base, name: "f", ctrl: true, shift: true }, "ctrl")!)).toBe("CmdOrCtrl+Shift+F");
    expect(serializeKeyChord(keyChordFromEvent({ ...base, name: "R" }, "ctrl")!)).toBe("Shift+R");
    expect(serializeKeyChord(keyChordFromEvent({ ...base, name: "escape" }, "ctrl")!)).toBe("Escape");
    expect(serializeKeyChord(keyChordFromEvent({ ...base, name: "?", shift: true }, "ctrl")!)).toBe("?");
  });

  test("a bare modifier is not a chord", () => {
    expect(keyChordFromEvent({ ...base, name: "shift", shift: true }, "ctrl")).toBeNull();
    expect(keyChordFromEvent({ ...base, name: "" }, "ctrl")).toBeNull();
  });
});

describe("isTypingChord", () => {
  test("flags keys a text field would consume", () => {
    expect(isTypingChord(parseKeyChord("a")!)).toBe(true);
    expect(isTypingChord(parseKeyChord("Shift+A")!)).toBe(true);
    expect(isTypingChord(parseKeyChord("Space")!)).toBe(true);
    expect(isTypingChord(parseKeyChord("Enter")!)).toBe(true);
    expect(isTypingChord(parseKeyChord("F5")!)).toBe(false);
    expect(isTypingChord(parseKeyChord("Alt+A")!)).toBe(false);
    expect(isTypingChord(parseKeyChord("CmdOrCtrl+Shift+A")!)).toBe(false);
    expect(isTypingChord(parseKeyChord("Escape")!)).toBe(false);
  });
});
