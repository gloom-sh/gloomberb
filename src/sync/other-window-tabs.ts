import type { AppState } from "../core/state/app/state";
import type { AppConfig } from "../types/config";
import type { OtherWindowTab } from "../types/desktop-window";

/**
 * Cloud sync runs in the desktop app's main window, whose state holds only
 * its own tabs while other windows are open. Sync sees every window's tabs:
 * the main window's as it has them now, the others' at their places among
 * them. Without this, a push would leave out the tabs in other windows, and
 * other devices would take them as deleted.
 *
 * The same state, unchanged, with one window, in the terminal and the browser.
 */
export function withOtherWindowTabs(state: AppState, others: readonly OtherWindowTab[]): AppState {
  if (others.length === 0) return state;
  const own = state.config.layouts;
  const layouts = [...own];
  for (const { at, tab } of [...others].sort((a, b) => a.at - b.at)) {
    // A pulled copy the main window holds for a moment, until the backend gives it back to its window.
    if (tab.id && layouts.some((entry) => entry.id === tab.id)) continue;
    layouts.splice(Math.min(at, layouts.length), 0, tab);
  }
  const active = own[state.config.activeLayoutIndex];
  const activeLayoutIndex = active ? layouts.indexOf(active) : state.config.activeLayoutIndex;
  return { ...state, config: { ...state.config, layouts, activeLayoutIndex: Math.max(0, activeLayoutIndex) } };
}

/**
 * Whether a config sync applies changes a tab another window holds. The whole
 * config is then saved at once: the backend keeps such a tab in its window
 * and takes the change where the pull made it. A later save of the main
 * window's own tabs would not carry it.
 */
export function changesOtherWindowTabs(config: AppConfig, others: readonly OtherWindowTab[]): boolean {
  const pulled = new Map(config.layouts.flatMap((entry) => (entry.id ? [[entry.id, entry] as const] : [])));
  return others.some(({ tab }) => {
    const next = tab.id ? pulled.get(tab.id) : undefined;
    return !!next && JSON.stringify(next) !== JSON.stringify(tab);
  });
}

/**
 * A config sync applies, as the main window keeps it: without the other
 * windows' tabs, which reach their windows through the whole config saved
 * (`changesOtherWindowTabs`). The main window stays on the tab it shows when
 * that tab is still there.
 */
export function withoutOtherWindowTabs(config: AppConfig, others: readonly OtherWindowTab[], current: AppConfig): AppConfig {
  const ids = new Set(others.flatMap(({ tab }) => (tab.id ? [tab.id] : [])));
  if (ids.size === 0) return config;
  const layouts = config.layouts.filter((entry) => !entry.id || !ids.has(entry.id));
  if (layouts.length === config.layouts.length || layouts.length === 0) return config;
  const shownId = current.layouts[current.activeLayoutIndex]?.id;
  const active = config.layouts[config.activeLayoutIndex];
  const byShown = shownId ? layouts.findIndex((entry) => entry.id === shownId) : -1;
  const byActive = active ? layouts.indexOf(active) : -1;
  const activeLayoutIndex = byActive >= 0 ? byActive : byShown >= 0 ? byShown : 0;
  const shown = layouts[activeLayoutIndex]!;
  // The live layout is the shown tab's: one of another window's tabs would draw here.
  const layout = byActive >= 0 ? config.layout : shown.layout;
  return { ...config, layouts, activeLayoutIndex, layout };
}
