import {
  dockStackTabIds,
  floatingStackMembers,
  getDockedPaneIds,
  hiddenDockTabIds,
  hiddenFloatingTabIds,
} from "../../../layout/pane-manager";
import type { PluginRegistry } from "../../../plugins/registry";
import { findPaneInstance, type LayoutConfig } from "../../../types/config";
import { collectDisabledPaneIds } from "../shell/visible-layout";

interface PaneCycleOptions {
  /**
   * Docked panes whose title bar floating windows hide: focus there could not
   * be seen, so Tab passes them by (`coveredDockedPaneIds`).
   */
  covered?: ReadonlySet<string>;
  /** Keeps its place in the order whatever covers it, so Tab moves on from where focus is. */
  focusedPaneId?: string | null;
}

/**
 * The panes Tab and Shift+Tab step through, docked then floating: every pane
 * that shows, a stack once (the tab it shows, never one it hides), and no
 * docked pane a floating window hides. When nothing but the covered panes is
 * left, those.
 */
export function getVisiblePaneCycleOrder(
  layout: LayoutConfig,
  pluginRegistry: PluginRegistry,
  disabledPlugins: readonly string[],
  { covered, focusedPaneId = null }: PaneCycleOptions = {},
): string[] {
  const disabledTypes = collectDisabledPaneIds(pluginRegistry, disabledPlugins);
  const hiddenTabs = new Set([...hiddenDockTabIds(layout), ...hiddenFloatingTabIds(layout.floating)]);
  const isVisiblePane = (instanceId: string) => {
    const instance = findPaneInstance(layout, instanceId);
    return !!instance
      && (!hiddenTabs.has(instanceId) || instanceId === focusedPaneId)
      && !disabledTypes.has(instance.paneId)
      && pluginRegistry.panes.has(instance.paneId);
  };

  const visible = [
    ...getDockedPaneIds(layout),
    ...layout.floating.map((entry) => entry.instanceId),
  ].filter(isVisiblePane);
  if (!covered || covered.size === 0) return visible;
  const shown = visible.filter((instanceId) => instanceId === focusedPaneId || !covered.has(instanceId));
  return shown.some((instanceId) => instanceId !== focusedPaneId) ? shown : visible;
}

/**
 * The tab of `paneId`'s stack, docked or floating, `direction` steps from it
 * in tab order, round from the last to the first: what the next- and
 * previous-tab keys show, since Tab passes the tabs a stack hides. Null when
 * the pane is in no stack.
 */
export function adjacentStackTabId(layout: LayoutConfig, paneId: string | null, direction: 1 | -1): string | null {
  if (!paneId) return null;
  const docked = dockStackTabIds(layout, paneId);
  const tabs = docked.length > 1 ? docked : floatingStackMembers(layout.floating, paneId).map((entry) => entry.instanceId);
  const index = tabs.indexOf(paneId);
  if (tabs.length < 2 || index < 0) return null;
  return tabs[(index + direction + tabs.length) % tabs.length]!;
}

const coveredSources = new Set<() => ReadonlySet<string>>();

/**
 * The shell says which docked panes its floating windows hide, as it lays
 * them out; Tab reads it when it moves focus. Returns the unregister.
 */
export function registerCoveredPaneSource(source: () => ReadonlySet<string>): () => void {
  coveredSources.add(source);
  return () => {
    coveredSources.delete(source);
  };
}

/** The docked panes the window's floating windows hide now (`registerCoveredPaneSource`). */
export function coveredDockedPaneIds(): ReadonlySet<string> {
  if (coveredSources.size === 0) return new Set();
  const covered = new Set<string>();
  for (const source of coveredSources) for (const id of source()) covered.add(id);
  return covered;
}
