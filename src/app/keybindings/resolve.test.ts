import { describe, expect, test } from "bun:test";
import { applyActionBinding, removeCommandBinding, setCommandBinding, updateKeybindingsConfig } from "./config";
import { parseKeyChord, serializeKeyChord } from "./chord";
import { coreActionOnChord, matchKeybinding, resolveKeybindings, resolvePluginShortcutChords } from "./resolve";
import { createDefaultConfig } from "../../types/config";

const base = { ctrl: false, shift: false, alt: false, meta: false, super: false };

describe("resolveKeybindings", () => {
  test("ships every default and reports nothing", () => {
    const resolved = resolveKeybindings(undefined);
    expect(resolved.issues).toEqual([]);
    expect(resolved.actionsById.get("ticker-search")?.chords.map(serializeKeyChord)).toEqual(["`"]);
    expect(matchKeybinding(resolved, { ...base, name: "`" })).toMatchObject({ kind: "action", id: "ticker-search" });
    expect(matchKeybinding(resolved, { ...base, name: "t", ctrl: true })).toBeNull();
    expect(matchKeybinding(resolved, { ...base, name: "2", super: true })).toMatchObject({ kind: "action", id: "switch-layout", digit: 2 });
    expect(matchKeybinding(resolved, { ...base, name: "w", ctrl: true, alt: true })).toMatchObject({ id: "close-floating-panes" });
    expect(matchKeybinding(resolved, { ...base, name: "w", ctrl: true })).toMatchObject({ id: "pane-close" });
    expect(matchKeybinding(resolved, { ...base, name: "z", meta: true })).toMatchObject({ id: "layout-undo" });
    expect(matchKeybinding(resolved, { ...base, name: "z", ctrl: true })).toMatchObject({ id: "layout-undo" });
    expect(matchKeybinding(resolved, { ...base, name: "z", meta: true, shift: true })).toMatchObject({ id: "layout-redo" });
    expect(matchKeybinding(resolved, { ...base, name: "x" })).toBeNull();
  });

  test("overrides replace defaults, null unbinds, and the rest stay put", () => {
    const resolved = resolveKeybindings({
      actions: { "ticker-search": "Ctrl+T", "command-bar": "Ctrl+Shift+P", help: null },
    });
    expect(resolved.issues).toEqual([]);
    expect(matchKeybinding(resolved, { ...base, name: "`" })).toBeNull();
    expect(matchKeybinding(resolved, { ...base, name: "t", ctrl: true })).toMatchObject({ id: "ticker-search" });
    expect(matchKeybinding(resolved, { ...base, name: "k", ctrl: true })).toBeNull();
    expect(matchKeybinding(resolved, { ...base, name: "p", ctrl: true, shift: true })).toMatchObject({ id: "command-bar" });
    expect(matchKeybinding(resolved, { ...base, name: "?", shift: true })).toBeNull();
    expect(resolved.actionsById.get("help")).toMatchObject({ custom: true, chords: [] });
    expect(resolved.actionsById.get("quit")).toMatchObject({ custom: false });
  });

  test("commands run after actions and need a modifier or function key", () => {
    const resolved = resolveKeybindings({
      commands: { "Alt+1": "DES AAPL", F5: " NEWS ", "CmdOrCtrl+W": "HN", a: "HN", "": "HN", "Alt+2": "" },
    });
    expect(matchKeybinding(resolved, { ...base, name: "1", alt: true })).toMatchObject({ kind: "command", command: { query: "DES AAPL" } });
    expect(matchKeybinding(resolved, { ...base, name: "f5" })).toMatchObject({ kind: "command", command: { query: "NEWS" } });
    expect(matchKeybinding(resolved, { ...base, name: "w", ctrl: true })).toMatchObject({ kind: "action", id: "pane-close" });
    expect(resolved.commands.map((command) => command.text)).toEqual(["Alt+1", "F5", "CmdOrCtrl+W"]);
    expect(resolved.issues).toEqual([
      { kind: "typing-chord", target: "commands", text: "a" },
      { kind: "invalid-chord", target: "commands", text: "" },
      { kind: "conflict", chord: parseKeyChord("CmdOrCtrl+W"), targets: ["pane-close", "command:CmdOrCtrl+W"] },
    ]);
  });

  test("reports unparseable overrides, unknown actions and overlapping chords", () => {
    const resolved = resolveKeybindings({
      actions: { "ticker-search": ["Ctrl+K", "Bogus+Q"], "not-a-thing": "F1" },
    });
    expect(resolved.issues).toEqual([
      { kind: "invalid-chord", target: "ticker-search", text: "Bogus+Q" },
      { kind: "unknown-action", actionId: "not-a-thing" },
      { kind: "conflict", chord: parseKeyChord("CmdOrCtrl+K"), targets: ["command-bar", "ticker-search"] },
    ]);
    // Table order decides, so the earlier action keeps the chord.
    expect(matchKeybinding(resolved, { ...base, name: "k", ctrl: true })).toMatchObject({ id: "command-bar" });
  });

  test("folds plugin shortcuts in under their own namespace", () => {
    const shortcut = { id: "hn-refresh", key: "x", ctrl: true, description: "Refresh", execute: () => {} };
    const plain = resolveKeybindings(undefined, { pluginShortcuts: [shortcut] });
    expect(matchKeybinding(plain, { ...base, name: "x", ctrl: true })).toMatchObject({ id: "plugin:hn-refresh" });
    expect(resolvePluginShortcutChords(undefined, shortcut).map(serializeKeyChord)).toEqual(["Ctrl+X"]);

    const config = { actions: { "plugin:hn-refresh": "Alt+X" } };
    const custom = resolveKeybindings(config, { pluginShortcuts: [shortcut] });
    expect(custom.issues).toEqual([]);
    expect(matchKeybinding(custom, { ...base, name: "x", ctrl: true })).toBeNull();
    expect(matchKeybinding(custom, { ...base, name: "x", alt: true })).toMatchObject({ id: "plugin:hn-refresh", action: { custom: true } });
    expect(resolvePluginShortcutChords(config, shortcut).map(serializeKeyChord)).toEqual(["Alt+X"]);
  });

  test("names the built-in action a captured chord would take from, a layout digit and the host's own actions included", () => {
    const chord = (text: string) => parseKeyChord(text)!;
    const shortcut = { id: "hn-refresh", key: "x", ctrl: true, description: "Refresh", execute: () => {} };
    const terminal = resolveKeybindings(undefined, { pluginShortcuts: [shortcut], host: "terminal" });
    expect(coreActionOnChord(terminal, chord("CmdOrCtrl+P"))?.id).toBe("command-bar");
    expect(coreActionOnChord(terminal, chord("CmdOrCtrl+3"))?.id).toBe("switch-layout");
    expect(coreActionOnChord(terminal, chord("Q"))?.id).toBe("quit");
    // Its own row, a plugin's key and a free chord are not taken.
    expect(coreActionOnChord(terminal, chord("CmdOrCtrl+W"), "pane-close")).toBeNull();
    expect(coreActionOnChord(terminal, chord("Ctrl+X"))).toBeNull();
    expect(coreActionOnChord(terminal, chord("CmdOrCtrl+Shift+Y"))).toBeNull();
    // The desktop app quits from its menu, so Q is free there.
    expect(coreActionOnChord(resolveKeybindings(undefined, { host: "desktop" }), chord("Q"))).toBeNull();
  });
});

describe("keybinding config edits", () => {
  test("applyActionBinding records overrides and drops ones equal to the default", () => {
    const bound = applyActionBinding(undefined, "ticker-search", [parseKeyChord("Ctrl+T")!]);
    expect(bound).toEqual({ actions: { "ticker-search": "Ctrl+T" } });
    const unbound = applyActionBinding(bound, "help", []);
    expect(unbound).toEqual({ actions: { "ticker-search": "Ctrl+T", help: null } });
    const restored = applyActionBinding(unbound, "ticker-search", [parseKeyChord("`")!]);
    expect(restored).toEqual({ actions: { help: null } });
    expect(applyActionBinding(restored, "help", [parseKeyChord("?")!])).toBeUndefined();
  });

  test("setCommandBinding replaces a command already on the chord, and removal clears the key", () => {
    const first = setCommandBinding(undefined, parseKeyChord("Alt+1")!, "DES AAPL");
    const second = setCommandBinding(first, parseKeyChord("alt+1")!, "HN");
    expect(second).toEqual({ commands: { "Alt+1": "HN" } });
    expect(removeCommandBinding(second, "Alt+1")).toBeUndefined();
  });

  test("updateKeybindingsConfig drops the key once nothing is customised", () => {
    const config = { ...createDefaultConfig("/tmp/keybindings"), keybindings: { actions: { help: null } } };
    expect(updateKeybindingsConfig(config, undefined).keybindings).toBeUndefined();
    expect("keybindings" in updateKeybindingsConfig(config, { actions: {} })).toBe(false);
    expect(updateKeybindingsConfig(config, { commands: { F5: "NEWS" } }).keybindings).toEqual({ commands: { F5: "NEWS" } });
  });
});
