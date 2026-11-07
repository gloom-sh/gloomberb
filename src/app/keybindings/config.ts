import type { AppConfig, KeybindingsConfig } from "../../types/config";
import { getKeybindingAction } from "./actions";
import { keyChordsEqual, parseKeyChord, serializeKeyChord, type KeyChord } from "./chord";

function withoutEmpty(config: KeybindingsConfig): KeybindingsConfig | undefined {
  const actions = config.actions && Object.keys(config.actions).length > 0 ? config.actions : undefined;
  const commands = config.commands && Object.keys(config.commands).length > 0 ? config.commands : undefined;
  if (!actions && !commands) return undefined;
  return { ...(actions ? { actions } : {}), ...(commands ? { commands } : {}) };
}

/** A config with `keybindings` replaced, and the key dropped once nothing is customised. */
export function updateKeybindingsConfig(config: AppConfig, keybindings: KeybindingsConfig | undefined): AppConfig {
  const next = keybindings ? withoutEmpty(keybindings) : undefined;
  const { keybindings: _previous, ...rest } = config;
  return next ? { ...rest, keybindings: next } : rest;
}

function defaultChordsFor(actionId: string, defaults?: readonly KeyChord[]): readonly KeyChord[] {
  if (defaults) return defaults;
  const def = getKeybindingAction(actionId);
  // Every host's defaults, as the table with no host has them.
  return def ? [...def.defaults, ...def.terminalDefaults ?? []].map((text) => parseKeyChord(text)!).filter(Boolean) : [];
}

function sameChords(left: readonly KeyChord[], right: readonly KeyChord[]): boolean {
  return left.length === right.length && left.every((chord, index) => keyChordsEqual(chord, right[index]!));
}

/**
 * Binds an action to `chords`. An empty list unbinds it; a list equal to the
 * defaults clears the override instead of recording a redundant one. Plugin
 * shortcuts pass their own defaults, since the table does not know them.
 */
export function applyActionBinding(
  config: KeybindingsConfig | undefined,
  actionId: string,
  chords: readonly KeyChord[],
  defaults?: readonly KeyChord[],
): KeybindingsConfig | undefined {
  const actions = { ...(config?.actions ?? {}) };
  if (sameChords(chords, defaultChordsFor(actionId, defaults))) {
    delete actions[actionId];
  } else if (chords.length === 0) {
    actions[actionId] = null;
  } else {
    const texts = chords.map(serializeKeyChord);
    actions[actionId] = texts.length === 1 ? texts[0]! : texts;
  }
  return withoutEmpty({ ...config, actions });
}

/** Binds a command bar query to a chord, replacing any command already on that chord. */
export function setCommandBinding(
  config: KeybindingsConfig | undefined,
  chord: KeyChord,
  query: string,
): KeybindingsConfig | undefined {
  const text = serializeKeyChord(chord);
  const commands: Record<string, string> = {};
  for (const [existingText, existingQuery] of Object.entries(config?.commands ?? {})) {
    const existing = parseKeyChord(existingText);
    if (existing && keyChordsEqual(existing, chord)) continue;
    commands[existingText] = existingQuery;
  }
  commands[text] = query.trim();
  return withoutEmpty({ ...config, commands });
}

/** Removes the command on `text`, matching by chord so `alt+1` and `Alt+1` are the same key. */
export function removeCommandBinding(
  config: KeybindingsConfig | undefined,
  text: string,
): KeybindingsConfig | undefined {
  const target = parseKeyChord(text);
  const commands: Record<string, string> = {};
  for (const [existingText, existingQuery] of Object.entries(config?.commands ?? {})) {
    if (existingText === text) continue;
    const existing = parseKeyChord(existingText);
    if (target && existing && keyChordsEqual(existing, target)) continue;
    commands[existingText] = existingQuery;
  }
  return withoutEmpty({ ...config, commands });
}
