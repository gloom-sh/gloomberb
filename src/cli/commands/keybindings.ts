import {
  applyActionBinding,
  describeKeybindingIssue,
  isCoreKeybindingActionId,
  isTypingChord,
  parseKeyChord,
  PLUGIN_ACTION_PREFIX,
  removeCommandBinding,
  resolveKeybindings,
  serializeKeyChord,
  setCommandBinding,
  updateKeybindingsConfig,
} from "../../app/keybindings";
import type { AppConfig } from "../../types/config";

export const KEYBINDINGS_CONFIG_KEY = "keybindings";

const UNBIND_WORDS = new Set(["null", "none", "off", "unbind"]);
const DEFAULT_WORDS = new Set(["default", "defaults", "reset"]);

/** The effective table with defaults filled in, plus anything that needs fixing. */
export function describeKeybindingsForCli(config: AppConfig): Record<string, unknown> {
  const resolved = resolveKeybindings(config.keybindings);
  return {
    actions: Object.fromEntries(resolved.actions.map((action) => [
      action.id,
      {
        keys: action.chords.map(serializeKeyChord),
        ...(action.custom ? { custom: true, defaults: action.defaults.map(serializeKeyChord) } : {}),
      },
    ])),
    commands: Object.fromEntries(resolved.commands.map((command) => [command.text, command.query])),
    issues: resolved.issues.map(describeKeybindingIssue),
  };
}

export type KeybindingCliSetResult =
  | { ok: true; config: AppConfig; value: unknown }
  | { ok: false; message: string };

/**
 * `config set keybindings.actions.<action> <chords>` and
 * `config set keybindings.commands.<chord> <query>`. Chords are separated by
 * whitespace, since no chord contains a space; `null` unbinds and `default`
 * clears an override.
 */
export function applyKeybindingCliSet(config: AppConfig, key: string, rawValue: string): KeybindingCliSetResult {
  const [, section, ...rest] = key.split(".");
  const target = rest.join(".");
  const value = rawValue.trim();
  if (!target) {
    return { ok: false, message: `Usage: gloom config set ${KEYBINDINGS_CONFIG_KEY}.actions.<action> <chord> or ${KEYBINDINGS_CONFIG_KEY}.commands.<chord> <query>` };
  }

  if (section === "actions") {
    if (!isCoreKeybindingActionId(target) && !target.startsWith(PLUGIN_ACTION_PREFIX)) {
      return { ok: false, message: `"${target}" is not a keybinding action. Run "gloom config get keybindings" for the list.` };
    }
    const lowered = value.toLowerCase();
    if (DEFAULT_WORDS.has(lowered)) {
      const actions = { ...(config.keybindings?.actions ?? {}) };
      delete actions[target];
      return { ok: true, config: updateKeybindingsConfig(config, { ...config.keybindings, actions }), value: "default" };
    }
    if (UNBIND_WORDS.has(lowered) || value === "") {
      return { ok: true, config: updateKeybindingsConfig(config, applyActionBinding(config.keybindings, target, [])), value: null };
    }
    const chords = [];
    for (const text of value.split(/\s+/)) {
      const chord = parseKeyChord(text);
      if (!chord) return { ok: false, message: `"${text}" is not a key chord. Examples: Ctrl+T, CmdOrCtrl+Shift+F, Alt+1, F5, \`` };
      chords.push(chord);
    }
    return {
      ok: true,
      config: updateKeybindingsConfig(config, applyActionBinding(config.keybindings, target, chords)),
      value: chords.map(serializeKeyChord),
    };
  }

  if (section === "commands") {
    const chord = parseKeyChord(target);
    if (!chord) return { ok: false, message: `"${target}" is not a key chord. Examples: Alt+1, CmdOrCtrl+Shift+N, F5` };
    if (UNBIND_WORDS.has(value.toLowerCase()) || value === "") {
      return {
        ok: true,
        config: updateKeybindingsConfig(config, removeCommandBinding(config.keybindings, serializeKeyChord(chord))),
        value: null,
      };
    }
    if (isTypingChord(chord)) {
      return { ok: false, message: `"${target}" would fire while typing; command bindings need Ctrl, Cmd, Alt or a function key.` };
    }
    return {
      ok: true,
      config: updateKeybindingsConfig(config, setCommandBinding(config.keybindings, chord, value)),
      value,
    };
  }

  return { ok: false, message: `Unknown keybindings section "${section ?? ""}". Use keybindings.actions or keybindings.commands.` };
}
