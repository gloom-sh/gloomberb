import { useSyncExternalStore } from "react";

/**
 * What the header prompt needs to act as the command bar's input while the bar
 * is open. Published by the panel, read by the header.
 *
 * A store rather than app state or context: the header and the command bar are
 * siblings, and the query of a nested screen (a picker, pane settings) lives in
 * the bar's own route stack, not in app state, so `state.commandBarQuery` alone
 * cannot drive the input.
 */
export interface CommandBarPromptBinding {
  /** Changes per screen so the input remounts with a fresh buffer. */
  screenKey: string;
  query: string;
  placeholder: string;
  /** Completion drawn after the typed text on the root screen, e.g. the ticker after "QQ". */
  ghostSuffix: string | null;
  onQueryChange: (query: string) => void;
}

let binding: CommandBarPromptBinding | null = null;
const listeners = new Set<() => void>();

function sameBinding(a: CommandBarPromptBinding | null, b: CommandBarPromptBinding | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.screenKey === b.screenKey
    && a.query === b.query
    && a.placeholder === b.placeholder
    && a.ghostSuffix === b.ghostSuffix
    && a.onQueryChange === b.onQueryChange;
}

export function publishCommandBarPrompt(next: CommandBarPromptBinding | null): void {
  if (sameBinding(binding, next)) return;
  binding = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CommandBarPromptBinding | null {
  return binding;
}

export function useCommandBarPromptBinding(): CommandBarPromptBinding | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
