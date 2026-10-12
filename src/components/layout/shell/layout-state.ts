import { useMemo } from "react";
import {
  resolveDocked,
  resolveFloating,
  type FloatingRect,
  type ResolvedPane,
} from "../../../layout/pane-manager";
import type { PluginRegistry } from "../../../plugins/registry";
import type { LayoutConfig } from "../../../types/config";
import { constrainFloatingRectToBounds } from "./drag";
import { collectDisabledPaneIds, resolveShellVisibleLayout } from "./visible-layout";

interface ShellVisibleLayoutOptions {
  disabledPlugins: readonly string[];
  layout: LayoutConfig;
  pluginRegistry: PluginRegistry;
}

export function useShellVisibleLayout({
  disabledPlugins,
  layout,
  pluginRegistry,
}: ShellVisibleLayoutOptions): {
  disabledPaneIds: Set<string>;
  visibleLayout: LayoutConfig;
} {
  const disabledPaneIds = useMemo(
    () => collectDisabledPaneIds(pluginRegistry, disabledPlugins),
    [disabledPlugins, pluginRegistry],
  );

  const visibleLayout = useMemo(
    () => resolveShellVisibleLayout(layout, disabledPaneIds, pluginRegistry.panes),
    [disabledPaneIds, layout, pluginRegistry.panes],
  );

  return { disabledPaneIds, visibleLayout };
}

interface ShellResolvedPanesOptions {
  activeLayout: LayoutConfig;
  contentHeight: number;
  disabledPaneIds: ReadonlySet<string>;
  pluginRegistry: PluginRegistry;
  width: number;
}

export function useShellResolvedPanes({
  activeLayout,
  contentHeight,
  disabledPaneIds,
  pluginRegistry,
  width,
}: ShellResolvedPanesOptions): {
  dockedPanes: ResolvedPane[];
  floatingPanes: ResolvedPane[];
  paneMap: Map<string, ResolvedPane>;
  visibleFloatingPanes: Array<{ pane: ResolvedPane; rect: FloatingRect }>;
} {
  const dockedPanes = useMemo(
    () => resolveDocked(activeLayout, pluginRegistry.panes).filter((pane) => !disabledPaneIds.has(pane.def.id)),
    [activeLayout, disabledPaneIds, pluginRegistry.panes],
  );
  const floatingPanes = useMemo(
    () => resolveFloating(activeLayout, pluginRegistry.panes).filter((pane) => !disabledPaneIds.has(pane.def.id)),
    [activeLayout, disabledPaneIds, pluginRegistry.panes],
  );
  const visibleFloatingPanes = useMemo(
    () => floatingPanes.map((pane) => ({
      pane,
      rect: constrainFloatingRectToBounds(pane.floating!, width, contentHeight),
    })),
    [contentHeight, floatingPanes, width],
  );
  const paneMap = useMemo(
    () => new Map([...dockedPanes, ...floatingPanes].map((pane) => [pane.instance.instanceId, pane])),
    [dockedPanes, floatingPanes],
  );

  return {
    dockedPanes,
    floatingPanes,
    paneMap,
    visibleFloatingPanes,
  };
}
