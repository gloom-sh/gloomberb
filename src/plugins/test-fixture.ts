import type { ReactElement } from "react";
import type { GloomPlugin } from "../types/plugin";

type Component = (props: never) => unknown;

function scopedNamespace(component: unknown): string | null {
  const name = (component as { displayName?: string } | null)?.displayName;
  return name?.match(/^PluginStateNamespace\((.+)\)$/)?.[1] ?? null;
}

/**
 * The state namespace a composed plugin's pane reads and writes: its module's
 * own, or else the plugin's.
 */
export function paneStateNamespace(plugin: GloomPlugin, paneId: string): string {
  const pane = plugin.panes?.find((candidate) => candidate.id === paneId);
  if (!pane) throw new Error(`${plugin.id} has no pane ${paneId}`);
  return scopedNamespace(pane.component) ?? plugin.stateId ?? plugin.id;
}

/**
 * The same for a component the registry wraps, a pane or a research tab. The
 * wrapper only returns elements, so nothing renders.
 */
export function registeredStateNamespace(component: Component): string {
  const provider = (component as (props: object) => ReactElement<{ pluginId: string; children: ReactElement }>)({});
  return scopedNamespace(provider.props.children.type) ?? provider.props.pluginId;
}
