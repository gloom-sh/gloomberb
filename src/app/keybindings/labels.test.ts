import { describe, expect, test } from "bun:test";
import { parseKeyChord } from "./chord";
import { advertisedChord, formatChordForHost, formatShortcutForHost } from "./labels";
import { resolveKeybindings } from "./resolve";

const chord = (text: string) => parseKeyChord(text)!;

describe("key labels per host", () => {
  test("the Mac desktop and a Mac browser use Apple's notation", () => {
    expect(formatChordForHost(chord("CmdOrCtrl+K"), "platform", "darwin")).toBe("⌘K");
    expect(formatChordForHost(chord("CmdOrCtrl+Shift+F"), "platform", "darwin")).toBe("⇧⌘F");
    expect(formatChordForHost(chord("Ctrl+P"), "platform", "darwin")).toBe("⌃P");
    expect(formatShortcutForHost("Shift+Enter", "platform", "darwin")).toBe("⇧↩");
    expect(formatShortcutForHost("CmdOrCtrl+C", "platform", "darwin")).toBe("⌘C");
  });

  test("Windows, Linux and every terminal keep the spelled-out keys", () => {
    for (const [mode, platform] of [["platform", "win32"], ["platform", "linux"], ["terminal", "darwin"], ["terminal", "linux"]] as const) {
      expect(formatChordForHost(chord("CmdOrCtrl+Shift+F"), mode, platform)).toBe("Ctrl+Shift+F");
      expect(formatChordForHost(chord("Alt+Enter"), mode, platform)).toBe("Alt+Enter");
      expect(formatShortcutForHost("Shift+Enter", mode, platform)).toBe("Shift+Enter");
      expect(formatShortcutForHost("CmdOrCtrl+C", mode, platform)).toBe("Ctrl+C");
    }
    expect(formatChordForHost(chord("Cmd+K"), "platform", "linux")).toBe("Super+K");
  });

  test("the status bar's compact form", () => {
    const digit = { ...chord("CmdOrCtrl+Digit"), key: "2" };
    expect(formatChordForHost(digit, "terminal", "darwin", { compact: true })).toBe("^2");
    expect(formatChordForHost(digit, "platform", "darwin", { compact: true })).toBe("⌘2");
    expect(formatChordForHost(chord("CmdOrCtrl+Shift+F"), "platform", "win32", { compact: true })).toBe("^⇧F");
    expect(formatChordForHost(chord("CmdOrCtrl+Shift+F"), "platform", "darwin", { compact: true })).toBe("⇧⌘F");
    expect(formatChordForHost(chord("Alt+1"), "platform", "linux", { compact: true })).toBe("Alt+1");
    expect(formatChordForHost(chord("Cmd+K"), "platform", "linux", { compact: true })).toBe("Super+K");
  });

  test("a terminal without the kitty protocol is shown the layout key it can send", () => {
    const resolved = resolveKeybindings(undefined, { host: "terminal" });
    const label = (legacyTerminal: boolean) => formatChordForHost(
      { ...advertisedChord(resolved, "switch-layout", "terminal", { legacyTerminal })!, key: "2" }, "terminal", "linux", { compact: true });
    expect(label(false)).toBe("^2");
    expect(label(true)).toBe("Alt+2");
  });
});
