import {
  cloneLayout,
  createPaneInstance,
  findPaneInstance,
  type AppConfig,
  type SavedLayout,
} from "../types/config";
import type { AppSessionSnapshot, PaneDef } from "../types/plugin";
import { addPaneFloating, bringToFront, getDockedPaneIds, isPaneInLayout } from "./pane-manager";

/**
 * Opening a pane from a CLI command that launches the UI.
 *
 * `gloomberb <something> <args>` has to leave the app in the state the
 * arguments describe before the first frame: the pane present, focused, and
 * already holding the query rather than whatever the last session left. That is
 * two writes with different lifetimes — the layout in the config, the pane's
 * own state in the session snapshot — and getting either subtly wrong (a second
 * instance, a floating pane behind the others, a stale search) is not visible
 * until someone runs the command. These two helpers are that logic, so a plugin
 * with a launch command does not reimplement the layout rules.
 */

export interface PaneLaunchPlacement {
  paneId: string;
  /** Used only when the layout has no instance of this pane yet. */
  instanceId: string;
  /** The plugin's own pane definition, for the floating size and position. */
  paneDef: PaneDef;
  /** Merged into the instance, so the pane reads the request on first render. */
  params?: Record<string, string>;
  terminalSize: { width: number; height: number };
}

function syncActiveLayout(
  layouts: SavedLayout[],
  activeLayoutIndex: number,
  nextLayout: AppConfig["layout"],
): SavedLayout[] {
  return layouts.map((entry, index) => (
    index === activeLayoutIndex
      ? { ...entry, layout: cloneLayout(nextLayout) }
      : { ...entry, layout: cloneLayout(entry.layout) }
  ));
}

/**
 * Returns the config with the pane open and frontmost, reusing the instance the
 * user already has rather than adding a second one: a launch command run
 * against a saved workspace should land in the pane that is already there.
 */
export function openPaneForLaunch(
  config: AppConfig,
  placement: PaneLaunchPlacement,
): { config: AppConfig; paneInstanceId: string } {
  const { paneId, instanceId, paneDef, params, terminalSize } = placement;
  let nextLayout = cloneLayout(config.layout);
  let targetInstance = nextLayout.instances.find((instance) => instance.paneId === paneId) ?? null;

  if (!targetInstance) {
    targetInstance = createPaneInstance(paneId, { instanceId, params });
    nextLayout = addPaneFloating(
      nextLayout,
      targetInstance,
      terminalSize.width,
      terminalSize.height,
      paneDef,
    );
  } else {
    const existingInstanceId = targetInstance.instanceId;
    nextLayout = {
      ...nextLayout,
      instances: nextLayout.instances.map((instance) => (
        instance.instanceId === existingInstanceId
          ? { ...instance, params: { ...(instance.params ?? {}), ...(params ?? {}) } }
          : instance
      )),
    };
    targetInstance = findPaneInstance(nextLayout, existingInstanceId) ?? targetInstance;
    // Present in `instances` but not placed: a pane the user closed without
    // discarding its settings. Put it back where a new one would go.
    if (!isPaneInLayout(nextLayout, existingInstanceId)) {
      nextLayout = addPaneFloating(
        nextLayout,
        targetInstance,
        terminalSize.width,
        terminalSize.height,
        paneDef,
      );
    } else if (nextLayout.floating.some((entry) => entry.instanceId === existingInstanceId)) {
      nextLayout = bringToFront(nextLayout, existingInstanceId);
    }
  }

  return {
    config: {
      ...config,
      layout: nextLayout,
      layouts: syncActiveLayout(config.layouts, config.activeLayoutIndex, nextLayout),
    },
    paneInstanceId: targetInstance.instanceId,
  };
}

/**
 * Returns the session snapshot with the pane focused and its plugin state
 * seeded, preserving everything else the previous session saved.
 */
export function seedPaneLaunchSession(
  config: AppConfig,
  snapshot: AppSessionSnapshot | null,
  options: {
    paneInstanceId: string;
    pluginId: string;
    pluginState: Record<string, unknown>;
  },
): AppSessionSnapshot {
  const { paneInstanceId, pluginId, pluginState } = options;
  const currentPaneState = snapshot?.paneState?.[paneInstanceId] ?? {};
  const currentPluginState =
    (currentPaneState.pluginState as Record<string, Record<string, unknown>> | undefined) ?? {};

  return {
    paneState: {
      ...(snapshot?.paneState ?? {}),
      [paneInstanceId]: {
        ...currentPaneState,
        pluginState: {
          ...currentPluginState,
          [pluginId]: { ...(currentPluginState[pluginId] ?? {}), ...pluginState },
        },
      },
    },
    focusedPaneId: paneInstanceId,
    activePanel: snapshot?.activePanel === "right" ? "right" : "left",
    statusBarVisible: snapshot?.statusBarVisible !== false,
    openPaneIds: [
      ...new Set([
        ...(snapshot?.openPaneIds ?? []),
        ...getDockedPaneIds(config.layout),
        ...config.layout.floating.map((entry) => entry.instanceId),
      ]),
    ],
    hydrationTargets: [...(snapshot?.hydrationTargets ?? [])],
    exchangeCurrencies: [...(snapshot?.exchangeCurrencies ?? [])],
    savedAt: Date.now(),
  };
}
