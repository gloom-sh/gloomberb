import { useSyncExternalStore } from "react";
import { createListenerSet } from "../../utils/listeners";
import type { KeyChord } from "./chord";

/**
 * Whether the terminal reports Control with any key (the kitty keyboard
 * protocol), as the terminal host learns it from the terminal's answers at
 * start: true when it does, false when the terminal answered without it, null
 * before it answers and outside a terminal. Without the protocol Control
 * never reaches a digit: Ctrl+1 arrives as 1, Ctrl+3 as Esc. Alt does, as Esc
 * then the digit.
 */
let reportsControlKeys: boolean | null = null;
const listeners = createListenerSet();

export function setTerminalReportsControlKeys(value: boolean | null): void {
  if (value === reportsControlKeys) return;
  reportsControlKeys = value;
  listeners.notify();
}

export function useTerminalReportsControlKeys(): boolean | null {
  return useSyncExternalStore(listeners.subscribe, () => reportsControlKeys, () => null);
}

/** Whether a terminal without the kitty protocol can send the chord: not Control with a digit. */
export function legacyTerminalSends(chord: KeyChord): boolean {
  return !((chord.ctrl || chord.primary) && (chord.key === "digit" || /^[0-9]$/.test(chord.key)));
}
