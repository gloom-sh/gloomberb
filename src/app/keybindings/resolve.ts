import type { KeybindingsConfig } from "../../types/config";
import type { KeyboardShortcut } from "../../types/plugin";
import {
  getKeybindingAction,
  isCoreKeybindingActionId,
  KEYBINDING_ACTIONS,
  PANE_ACTION_IDS,
  PLUGIN_ACTION_PREFIX,
  pluginShortcutActionId,
  type KeybindingActionDef,
} from "./actions";
import {
  isTypingChord,
  keyChordDigit,
  matchesKeyChord,
  parseKeyChord,
  serializeKeyChord,
  type KeyChord,
  type KeyChordEventLike,
} from "./chord";

export interface ResolvedKeybindingAction {
  id: string;
  /** Set for built-in actions. */
  def?: KeybindingActionDef;
  /** Set for actions a plugin registered. */
  pluginShortcut?: KeyboardShortcut;
  chords: KeyChord[];
  defaults: KeyChord[];
  /** The user replaced or removed the default chords. */
  custom: boolean;
}

export interface KeybindingCommand {
  chord: KeyChord;
  /** The chord text as written in the config, which is the map key. */
  text: string;
  /** Command bar text submitted when the chord is pressed. */
  query: string;
}

export type KeybindingIssue =
  | { kind: "invalid-chord"; target: string; text: string }
  | { kind: "unknown-action"; actionId: string }
  | { kind: "typing-chord"; target: string; text: string }
  | { kind: "conflict"; chord: KeyChord; targets: string[] };

export interface ResolvedKeybindings {
  actions: ResolvedKeybindingAction[];
  actionsById: Map<string, ResolvedKeybindingAction>;
  commands: KeybindingCommand[];
  issues: KeybindingIssue[];
}

export type KeybindingMatch =
  | { kind: "action"; id: string; action: ResolvedKeybindingAction; digit: number | null }
  | { kind: "command"; command: KeybindingCommand };

export interface ResolveKeybindingsOptions {
  /** Plugin shortcuts to fold into the table, for listing and conflict checks. */
  pluginShortcuts?: Iterable<KeyboardShortcut>;
  /**
   * The host the table is for. Actions the host does not have (quit on the
   * desktop, pop-out in the terminal) then neither match nor conflict.
   */
  host?: "terminal" | "desktop";
}

export function pluginShortcutDefaultChord(shortcut: KeyboardShortcut): KeyChord {
  return {
    key: shortcut.key.toLowerCase(),
    ctrl: shortcut.ctrl === true,
    cmd: false,
    primary: false,
    alt: false,
    shift: shortcut.shift === true || (shortcut.key.length === 1 && shortcut.key !== shortcut.key.toLowerCase()),
  };
}

/**
 * An override's chords. `null` in the config is a deliberate unbind and gives
 * an empty list; text that does not parse is reported and dropped, and when
 * nothing parses the override is ignored so a typo never silently unbinds.
 */
function parseChordList(
  value: string | string[] | null | undefined,
  target: string,
  issues: KeybindingIssue[],
): KeyChord[] | null {
  if (value === undefined) return null;
  if (value === null) return [];
  const texts = Array.isArray(value) ? value : [value];
  const chords: KeyChord[] = [];
  let invalid = false;
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const chord = parseKeyChord(text);
    if (!chord) {
      issues.push({ kind: "invalid-chord", target, text });
      invalid = true;
      continue;
    }
    chords.push(chord);
  }
  return chords.length === 0 && invalid ? null : chords;
}

function parseDefaults(texts: readonly string[]): KeyChord[] {
  return texts.map((text) => {
    const chord = parseKeyChord(text);
    if (!chord) throw new Error(`Default keybinding "${text}" does not parse.`);
    return chord;
  });
}

const DEFAULT_CHORDS = new Map(KEYBINDING_ACTIONS.map((action) => [action.id, parseDefaults(action.defaults)]));

/**
 * Two chords fire on the same keypress somewhere: identical, or one says
 * `CmdOrCtrl` where the other names Control or Command explicitly.
 */
export function keyChordsOverlap(left: KeyChord, right: KeyChord): boolean {
  if (left.key !== right.key || left.alt !== right.alt || left.shift !== right.shift) return false;
  if (left.primary && right.primary) return true;
  if (left.primary) return (right.ctrl || right.cmd) && !(right.ctrl && right.cmd);
  if (right.primary) return (left.ctrl || left.cmd) && !(left.ctrl && left.cmd);
  return left.ctrl === right.ctrl && left.cmd === right.cmd;
}

function resolveAction(
  def: KeybindingActionDef | undefined,
  pluginShortcut: KeyboardShortcut | undefined,
  id: string,
  defaults: KeyChord[],
  overrides: NonNullable<KeybindingsConfig["actions"]>,
  issues: KeybindingIssue[],
): ResolvedKeybindingAction {
  const override = parseChordList(overrides[id], id, issues);
  return {
    id,
    def,
    pluginShortcut,
    defaults,
    chords: override ?? defaults,
    custom: override !== null,
  };
}

function collectConflicts(actions: ResolvedKeybindingAction[], commands: KeybindingCommand[]): KeybindingIssue[] {
  const entries: Array<{ target: string; chord: KeyChord }> = [
    ...actions.flatMap((action) => action.chords.map((chord) => ({ target: action.id, chord }))),
    ...commands.map((command) => ({ target: `command:${command.text}`, chord: command.chord })),
  ];
  const reported = new Set<string>();
  const issues: KeybindingIssue[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const targets = [entry.target];
    for (let other = index + 1; other < entries.length; other += 1) {
      const candidate = entries[other]!;
      if (candidate.target !== entry.target && keyChordsOverlap(entry.chord, candidate.chord)) {
        targets.push(candidate.target);
      }
    }
    if (targets.length < 2) continue;
    const key = `${serializeKeyChord(entry.chord)}|${[...new Set(targets)].sort().join(",")}`;
    if (reported.has(key)) continue;
    reported.add(key);
    issues.push({ kind: "conflict", chord: entry.chord, targets: [...new Set(targets)] });
  }
  return issues;
}

export function resolveKeybindings(
  config: KeybindingsConfig | undefined,
  options: ResolveKeybindingsOptions = {},
): ResolvedKeybindings {
  const issues: KeybindingIssue[] = [];
  const overrides = config?.actions ?? {};
  const hostActions = KEYBINDING_ACTIONS.filter((def) => (
    options.host === "desktop" ? !def.terminalOnly : options.host === "terminal" ? !def.desktopOnly : true
  ));
  const actions: ResolvedKeybindingAction[] = hostActions.map((def) => resolveAction(
    def,
    undefined,
    def.id,
    DEFAULT_CHORDS.get(def.id)!,
    overrides,
    issues,
  ));
  for (const shortcut of options.pluginShortcuts ?? []) {
    actions.push(resolveAction(
      undefined,
      shortcut,
      pluginShortcutActionId(shortcut.id),
      [pluginShortcutDefaultChord(shortcut)],
      overrides,
      issues,
    ));
  }
  for (const actionId of Object.keys(overrides)) {
    if (isCoreKeybindingActionId(actionId) || actionId.startsWith(PLUGIN_ACTION_PREFIX)) continue;
    issues.push({ kind: "unknown-action", actionId });
  }

  const commands: KeybindingCommand[] = [];
  for (const [text, query] of Object.entries(config?.commands ?? {})) {
    if (typeof query !== "string" || !query.trim()) continue;
    const chord = parseKeyChord(text);
    if (!chord) {
      issues.push({ kind: "invalid-chord", target: "commands", text });
      continue;
    }
    if (isTypingChord(chord)) {
      issues.push({ kind: "typing-chord", target: "commands", text });
      continue;
    }
    commands.push({ chord, text, query: query.trim() });
  }

  issues.push(...collectConflicts(actions, commands));

  return {
    actions,
    actionsById: new Map(actions.map((action) => [action.id, action])),
    commands,
    issues,
  };
}

/**
 * The first action or command whose chord the event is, in table order. Actions
 * win over commands, so a stray command binding never shadows a core key.
 */
export function matchKeybinding(resolved: ResolvedKeybindings, event: KeyChordEventLike): KeybindingMatch | null {
  for (const action of resolved.actions) {
    for (const chord of action.chords) {
      if (!matchesKeyChord(chord, event)) continue;
      return {
        kind: "action",
        id: action.id,
        action,
        digit: chord.key === "digit" ? keyChordDigit(event) : null,
      };
    }
  }
  for (const command of resolved.commands) {
    if (matchesKeyChord(command.chord, event)) return { kind: "command", command };
  }
  return null;
}

export function matchesKeybindingAction(resolved: ResolvedKeybindings, id: string, event: KeyChordEventLike): boolean {
  const action = resolved.actionsById.get(id);
  return !!action && action.chords.some((chord) => matchesKeyChord(chord, event));
}

export function isPaneKeybindingAction(id: string): boolean {
  return isCoreKeybindingActionId(id) && PANE_ACTION_IDS.has(id);
}

/**
 * Chords for one plugin shortcut, honouring an override, for a handler that
 * reads the live registry instead of a resolved table.
 */
export function resolvePluginShortcutChords(config: KeybindingsConfig | undefined, shortcut: KeyboardShortcut): KeyChord[] {
  const override = parseChordList(config?.actions?.[pluginShortcutActionId(shortcut.id)], shortcut.id, []);
  return override ?? [pluginShortcutDefaultChord(shortcut)];
}

export function describeKeybindingIssue(issue: KeybindingIssue): string {
  switch (issue.kind) {
    case "invalid-chord":
      return `"${issue.text}" is not a key chord (${issue.target}).`;
    case "unknown-action":
      return `"${issue.actionId}" is not a keybinding action.`;
    case "typing-chord":
      return `"${issue.text}" would fire while typing; command bindings need Ctrl, Cmd, Alt or a function key.`;
    case "conflict":
      return `${serializeKeyChord(issue.chord)} is bound to ${issue.targets.join(" and ")}.`;
  }
}

export function keybindingActionLabel(action: ResolvedKeybindingAction): string {
  return action.def?.description ?? action.pluginShortcut?.description ?? action.id;
}

export { getKeybindingAction };
