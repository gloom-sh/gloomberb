import { useLayoutEffect, useRef } from "react";
import { isTypingChord, matchesKeyChord, parseKeyChord, type KeyChord } from "../../../../app/keybindings/chord";
import { useShortcut, type KeyEventLike } from "../../../../react/input";
import { useOptionalAppSelector } from "../../../../state/app/context";
import type { CombinedPaneFooter } from "./model";

const chordCache = new Map<string, KeyChord | null>();

/** Each mounted pane's current footer, for the pane menu to list its actions. */
const paneFooters = new Map<string, CombinedPaneFooter>();

export function getPaneFooter(paneId: string): CombinedPaneFooter | undefined {
  return paneFooters.get(paneId);
}

/**
 * Hint keys are written the way the footer shows them: `a`, `!`, `Enter`,
 * `Ctrl+S`, and `G` for Shift+G, since a capital is what the user presses.
 */
function hintChord(key: string): KeyChord | null {
  let chord = chordCache.get(key);
  if (chord === undefined) {
    chord = parseKeyChord(key);
    if (chord && /^[A-Z]$/.test(key)) chord = { ...chord, shift: true };
    chordCache.set(key, chord);
  }
  return chord;
}

/**
 * The footer action a key press names: an enabled hint, or an info segment that
 * advertises a shortcut. A typed character never reaches one while a field owns
 * the keyboard.
 */
export function resolvePaneFooterKey(
  footer: CombinedPaneFooter,
  event: KeyEventLike,
  typingBlocked: boolean,
): (() => void) | null {
  const candidates: Array<{ key: string; press: () => void }> = [];
  for (const hint of [...footer.hints, ...footer.keys]) {
    if (hint.disabled || !hint.onPress) continue;
    const onPress = hint.onPress;
    candidates.push({ key: hint.key, press: () => onPress() });
  }
  for (const segment of footer.info) {
    if (segment.disabled || !segment.onPress || !segment.shortcut) continue;
    candidates.push({ key: segment.shortcut, press: segment.onPress });
  }
  for (const candidate of candidates) {
    const chord = hintChord(candidate.key);
    if (!chord || !matchesKeyChord(chord, event)) continue;
    if (typingBlocked && isTypingChord(chord)) return null;
    return candidate.press;
  }
  return null;
}

/**
 * Every footer hint is a key binding while its pane is focused, so a pane that
 * shows `[a]dd` does not also have to remember to bind `a`. Runs after the
 * pane's own handlers: a pane that binds the key itself keeps it, and this only
 * fills in the hints nobody handled.
 */
export function PaneFooterKeys({
  paneId,
  footer,
  focused,
}: {
  paneId: string;
  footer: CombinedPaneFooter;
  focused: boolean;
}): null {
  useLayoutEffect(() => {
    paneFooters.set(paneId, footer);
  }, [footer, paneId]);
  useLayoutEffect(() => () => {
    paneFooters.delete(paneId);
  }, [paneId]);
  const inputCaptured = useOptionalAppSelector((state) => state.inputCaptured, false);
  const footerRef = useRef(footer);
  footerRef.current = footer;
  const inputCapturedRef = useRef(inputCaptured);
  inputCapturedRef.current = inputCaptured;

  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped) return;
    const typingBlocked = inputCapturedRef.current || event.targetEditable === true;
    const press = resolvePaneFooterKey(footerRef.current, event, typingBlocked);
    if (!press) return;
    event.preventDefault();
    event.stopPropagation();
    press();
  }, { phase: "after", enabled: focused });
  return null;
}
