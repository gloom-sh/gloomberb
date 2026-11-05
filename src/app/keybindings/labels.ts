import {
  detectShortcutPlatform,
  type ShortcutDisplayMode,
  type ShortcutPlatform,
} from "../../utils/shortcut-labels";
import { t, tf } from "../../i18n";
import {
  formatKeyChord,
  formatShortcutText,
  serializeKeyChord,
  type FormatKeyChordOptions,
  type KeyChord,
  type KeyNotation,
  type PrimaryModifier,
} from "./chord";
import type { ResolvedKeybindingAction, ResolvedKeybindings } from "./resolve";

/** What `CmdOrCtrl` is on this host: Control in a terminal, Command on a Mac desktop. */
export function primaryModifierFor(
  mode: ShortcutDisplayMode,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): PrimaryModifier {
  if (mode === "terminal") return "ctrl";
  return platform === "darwin" ? "cmd" : "ctrl";
}

function cmdLabelFor(platform: ShortcutPlatform): string {
  return platform === "darwin" ? "Cmd" : "Super";
}

/**
 * Apple's symbols on a Mac, in the desktop app and in a Mac browser; spelled-out
 * keys in a terminal, which reads Control on a Mac too, and on Windows and Linux.
 */
export function keyNotationFor(
  mode: ShortcutDisplayMode,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): KeyNotation {
  return mode === "platform" && platform === "darwin" ? "mac" : "text";
}

function hostFormatOptions(mode: ShortcutDisplayMode, platform: ShortcutPlatform): FormatKeyChordOptions {
  return {
    primaryModifier: primaryModifierFor(mode, platform),
    cmdLabel: cmdLabelFor(platform),
    notation: keyNotationFor(mode, platform),
  };
}

/**
 * Every key label the app shows goes through here or {@link formatShortcutForHost}:
 * `Ctrl+Shift+F` in a terminal and on Windows and Linux, `⇧⌘F` on a Mac.
 * `compact` is the status bar's tab form (`^2`, `^⇧F`).
 */
export function formatChordForHost(
  chord: KeyChord,
  mode: ShortcutDisplayMode,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  { compact = false }: { compact?: boolean } = {},
): string {
  return formatKeyChord(chord, { ...hostFormatOptions(mode, platform), compact });
}

/**
 * A key written as text (`Ctrl+S`, `Shift+Enter`, `CmdOrCtrl+F`,
 * `Shift+Left/Right`) as this host shows keys: `⌃S`, `⇧↩`, `⌘F`, `⇧←/→` on a
 * Mac, as written elsewhere, with `CmdOrCtrl` resolved to Ctrl.
 */
export function formatShortcutForHost(
  text: string,
  mode: ShortcutDisplayMode,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  return formatShortcutText(text, hostFormatOptions(mode, platform));
}

/**
 * Chords worth showing on this host. A terminal cannot deliver an explicit
 * Command chord, so those rows stay out of the terminal's help.
 */
function chordsForHost(chords: readonly KeyChord[], mode: ShortcutDisplayMode): KeyChord[] {
  return chords.filter((chord) => mode !== "terminal" || !chord.cmd);
}

export function formatActionChords(
  resolved: ResolvedKeybindings,
  actionId: string,
  mode: ShortcutDisplayMode,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string[] {
  const action = resolved.actionsById.get(actionId);
  if (!action) return [];
  return chordsForHost(action.chords, mode).map((chord) => formatChordForHost(chord, mode, platform));
}

/**
 * The one chord a host advertises for an action when there is room for a single
 * label. The terminal takes the first chord it can deliver; desktop hosts prefer
 * a chord on the platform modifier, so the header says ⌘K on a Mac while the
 * terminal keeps saying Ctrl+P. Empty when the action is unbound.
 */
export function advertisedChord(
  resolved: ResolvedKeybindings,
  actionId: string,
  mode: ShortcutDisplayMode,
): KeyChord | null {
  const chords = chordsForHost(resolved.actionsById.get(actionId)?.chords ?? [], mode);
  if (chords.length === 0) return null;
  if (mode === "terminal") return chords[0]!;
  return chords.find((chord) => chord.primary || chord.cmd) ?? chords[0]!;
}

export function formatAdvertisedChord(
  resolved: ResolvedKeybindings,
  actionId: string,
  mode: ShortcutDisplayMode,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  const chord = advertisedChord(resolved, actionId, mode);
  return chord ? formatChordForHost(chord, mode, platform) : "";
}

/**
 * The accelerator a native menu shows for an action. Menus only take chords on
 * the platform modifier: a bare backtick as a key equivalent would swallow the
 * character everywhere.
 */
export function menuAcceleratorFor(resolved: ResolvedKeybindings, actionId: string): string | undefined {
  const chord = resolved.actionsById.get(actionId)?.chords.find((entry) => entry.primary || entry.cmd);
  return chord ? serializeKeyChord(chord) : undefined;
}

/** The first clause of a description, for messages that name an action mid-sentence. */
export function shortActionLabel(description: string): string {
  const clause = description.split(/[,.](?:\s|$)/)[0] ?? description;
  return clause.trim() || description.trim();
}

/**
 * Why a chord a built-in action uses (coreActionOnChord) is refused, the
 * same in the shortcuts editor and `config set keybindings`: "Ctrl+P is
 * taken: Open the command bar. Press another key."
 */
export function takenChordMessage(chord: string, action: ResolvedKeybindingAction): string {
  const name = action.def ? t(action.def.description) : action.pluginShortcut?.description ?? action.id;
  return tf("{chord} is taken: {target}. Press another key.", { chord, target: shortActionLabel(name) });
}
