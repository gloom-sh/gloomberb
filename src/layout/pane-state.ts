import type { PaneRuntimeState } from "../core/state/app/state";

export function getPluginPaneStateValue<T>(
  paneState: PaneRuntimeState | undefined,
  pluginId: string,
  key: string,
  fallback: T,
): T {
  return (paneState?.pluginState?.[pluginId]?.[key] as T | undefined) ?? fallback;
}

export function setPluginPaneStateValue(
  paneState: PaneRuntimeState | undefined,
  pluginId: string,
  key: string,
  value: unknown,
): Record<string, Record<string, unknown>> {
  return {
    ...(paneState?.pluginState ?? {}),
    [pluginId]: {
      ...(paneState?.pluginState?.[pluginId] ?? {}),
      [key]: value,
    },
  };
}

export function deletePluginPaneStateValue(
  paneState: PaneRuntimeState | undefined,
  pluginId: string,
  key: string,
): Record<string, Record<string, unknown>> | undefined {
  const pluginState = paneState?.pluginState?.[pluginId];
  if (!pluginState || !(key in pluginState)) {
    return paneState?.pluginState;
  }

  const nextPluginState = { ...pluginState };
  delete nextPluginState[key];

  const nextAllPluginState = { ...(paneState?.pluginState ?? {}) };
  if (Object.keys(nextPluginState).length === 0) {
    delete nextAllPluginState[pluginId];
  } else {
    nextAllPluginState[pluginId] = nextPluginState;
  }

  return Object.keys(nextAllPluginState).length > 0 ? nextAllPluginState : undefined;
}
