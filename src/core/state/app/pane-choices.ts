import type { AppState, PaneRuntimeState } from "./types";

/**
 * Which pane-state values were chosen in this session, as opposed to restored
 * with a workspace: a start, a desk switch, a layout or a snapshot applied
 * brings back what an earlier session chose. A write of the key in this
 * session, by any route (a pick in the pane, a command, a link, a plugin) and
 * even of the value it already holds, is the user asking for it.
 *
 * Some choices need Gloom Cloud Pro. Restored for an account without it, the
 * pane shows its free default instead of a wall nobody asked for
 * (`shownPaneChoice`), and keeps the saved choice for when the plan has Pro.
 */

const NO_CHOICES: Readonly<Record<string, true>> = {};

/** The choice key of a plugin's pane-state value (`usePluginPaneState`). */
export function pluginChoiceKey(pluginId: string, key: string): string {
  return `plugin:${pluginId}:${key}`;
}

/** `state` with `keys` of `paneId` marked as chosen in this session; the same object when they already were. */
export function withPaneChoices(state: AppState, paneId: string, keys: Iterable<string>): AppState {
  const current = state.paneChoices?.[paneId] ?? NO_CHOICES;
  let next: Record<string, true> | null = null;
  for (const key of keys) {
    if (current[key] || next?.[key]) continue;
    next ??= { ...current };
    next[key] = true;
  }
  return next ? { ...state, paneChoices: { ...state.paneChoices, [paneId]: next } } : state;
}

/** Every key a replaced pane state holds, its plugins' values included. */
export function paneStateChoiceKeys(paneState: PaneRuntimeState): string[] {
  const keys = Object.keys(paneState);
  for (const [pluginId, values] of Object.entries(paneState.pluginState ?? {})) {
    for (const key of Object.keys(values ?? {})) keys.push(pluginChoiceKey(pluginId, key));
  }
  return keys;
}

/** `state` with every pane-state value it holds marked as chosen now. */
export function withAllPaneChoices(state: AppState): AppState {
  return Object.entries(state.paneState).reduce(
    (current, [paneId, paneState]) => withPaneChoices(current, paneId, paneStateChoiceKeys(paneState)),
    state,
  );
}

export function isPaneChoice(state: AppState, paneId: string, key: string): boolean {
  return state.paneChoices?.[paneId]?.[key] === true;
}

/**
 * What a pane shows for its saved `value`: the value itself, except one only
 * Pro opens (`proOnly`) restored for an account without Pro, which shows
 * `fallback` until the user chooses it in this session. Nothing is rewritten:
 * the same account after upgrading, or a Pro one, gets the saved value back.
 */
export function shownPaneChoice<T>(value: T, options: {
  chosen: boolean;
  hasProAccess: boolean;
  proOnly: (value: T) => boolean;
  fallback: T;
}): T {
  return options.chosen || options.hasProAccess || !options.proOnly(value) ? value : options.fallback;
}
