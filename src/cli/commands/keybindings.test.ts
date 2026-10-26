import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import { applyKeybindingCliSet, describeKeybindingsForCli } from "./keybindings";

const config = createDefaultConfig("/tmp/gloomberb-cli-keybindings");

describe("config set keybindings", () => {
  test("binds, unbinds and restores actions", () => {
    const bound = applyKeybindingCliSet(config, "keybindings.actions.ticker-search", "Ctrl+T `");
    if (!bound.ok) throw new Error(bound.message);
    expect(bound.value).toEqual(["Ctrl+T", "`"]);
    expect(bound.config.keybindings).toEqual({ actions: { "ticker-search": ["Ctrl+T", "`"] } });

    const unbound = applyKeybindingCliSet(bound.config, "keybindings.actions.help", "null");
    if (!unbound.ok) throw new Error(unbound.message);
    expect(unbound.config.keybindings?.actions).toEqual({ "ticker-search": ["Ctrl+T", "`"], help: null });

    const restored = applyKeybindingCliSet(unbound.config, "keybindings.actions.ticker-search", "default");
    if (!restored.ok) throw new Error(restored.message);
    expect(restored.config.keybindings).toEqual({ actions: { help: null } });
    expect(describeKeybindingsForCli(restored.config)).toMatchObject({
      actions: {
        help: { keys: [], custom: true, defaults: ["?"] },
        "ticker-search": { keys: ["`"] },
      },
      issues: [],
    });
  });

  test("binds and removes commands, refusing chords a text field would eat", () => {
    const bound = applyKeybindingCliSet(config, "keybindings.commands.alt+1", "DES AAPL");
    if (!bound.ok) throw new Error(bound.message);
    expect(bound.config.keybindings).toEqual({ commands: { "Alt+1": "DES AAPL" } });

    const removed = applyKeybindingCliSet(bound.config, "keybindings.commands.Alt+1", "null");
    if (!removed.ok) throw new Error(removed.message);
    expect(removed.config.keybindings).toBeUndefined();

    expect(applyKeybindingCliSet(config, "keybindings.commands.a", "HN")).toMatchObject({ ok: false });
  });

  test("refuses a chord a built-in action uses, naming it as the shortcuts editor does, and saves nothing", () => {
    expect(applyKeybindingCliSet(config, "keybindings.actions.ticker-search", "Ctrl+P")).toEqual({
      ok: false, message: "Ctrl+P is taken: Open the command bar. Press another key.",
    });
    expect(applyKeybindingCliSet(config, "keybindings.commands.Ctrl+W", "DES AAPL")).toEqual({
      ok: false, message: "Ctrl+W is taken: Close the focused pane. Press another key.",
    });
    // Quit keeps Q though only the terminal has it.
    expect(applyKeybindingCliSet(config, "keybindings.actions.help", "Q")).toMatchObject({ ok: false, message: expect.stringContaining("Q is taken") });
    // An action keeps its own key, and one moved off a key frees it.
    expect(applyKeybindingCliSet(config, "keybindings.actions.command-bar", "CmdOrCtrl+P F2")).toMatchObject({ ok: true });
    const moved = applyKeybindingCliSet(config, "keybindings.actions.command-bar", "F2");
    if (!moved.ok) throw new Error(moved.message);
    expect(applyKeybindingCliSet(moved.config, "keybindings.actions.ticker-search", "Ctrl+P")).toMatchObject({ ok: true });
  });

  test("rejects unknown actions, bad chords and bad sections with a usable message", () => {
    expect(applyKeybindingCliSet(config, "keybindings.actions.nope", "F1")).toMatchObject({ ok: false, message: expect.stringContaining("not a keybinding action") });
    expect(applyKeybindingCliSet(config, "keybindings.actions.quit", "Hyper+Q")).toMatchObject({ ok: false, message: expect.stringContaining("not a key chord") });
    expect(applyKeybindingCliSet(config, "keybindings.other.x", "F1")).toMatchObject({ ok: false });
    expect(applyKeybindingCliSet(config, "keybindings.actions", "F1")).toMatchObject({ ok: false });
  });
});
