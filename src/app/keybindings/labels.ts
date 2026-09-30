import {
  detectShortcutPlatform,
  type ShortcutDisplayMode,
  type ShortcutPlatform,
} from "../../utils/shortcut-labels";
import { formatKeyChord, serializeKeyChord, type KeyChord, type PrimaryModifier } from "./chord";
import type { ResolvedKeybindings } from "./resolve";

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

export function formatChordForHost(
  chord: KeyChord,
  mode: ShortcutDisplayMode,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  return formatKeyChord(chord, {
    primaryModifier: primaryModifierFor(mode, platform),
    cmdLabel: cmdLabelFor(platform),
  });
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
 * a chord on the platform modifier, so the header says Cmd+K on a Mac while the
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
