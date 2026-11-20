import type { ShortcutDisplayMode } from "../../utils/shortcut-labels";
import { formatActionChords } from "./labels";
import { isTypingChord, matchesKeyChord, type KeyChordEventLike } from "./chord";
import { matchKeybinding, type ResolvedKeybindings } from "./resolve";

export type NavigationAction = "left" | "right" | "up" | "down" | "prev-view" | "next-view";

/** Local navigation never takes a global shortcut or text typed into a field. */
export function matchesNavigationKey(
  bindings: ResolvedKeybindings,
  action: NavigationAction,
  event: KeyChordEventLike & { targetEditable?: boolean },
  { allowEditable = false, defaultMatches }: { allowEditable?: boolean; defaultMatches?: boolean } = {},
): boolean {
  if (event.targetEditable && !allowEditable) return false;
  const id = `navigate-${action}`;
  if (defaultMatches !== undefined && !bindings.actionsById.get(id)?.custom) return defaultMatches;
  if (matchKeybinding(bindings, event)) return false;
  // Table order resolves hand-edited conflicts the same way as global bindings.
  const match = bindings.actions.find((entry) => entry.def?.category === "Navigation"
    && entry.chords.some((chord) => (!event.targetEditable || !isTypingChord(chord)) && matchesKeyChord(chord, event)));
  return match?.id === id;
}

/** Keep the existing window-mode hint with defaults, and name the configured keys otherwise. */
export function navigationDirectionLabel(bindings: ResolvedKeybindings, mode: ShortcutDisplayMode): string {
  const directions = ["left", "down", "up", "right"] as const;
  if (directions.every((direction) => !bindings.actionsById.get(`navigate-${direction}`)?.custom)) return "arrows";
  return directions.flatMap((direction) => formatActionChords(bindings, `navigate-${direction}`, mode).slice(0, 1)).join("/") || "unbound";
}
