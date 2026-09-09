import type { PaneRuntimeState } from "../../core/state/app/state";
import { deletePaneSetting, setPaneSetting } from "../../pane-settings";
import type { LayoutConfig } from "../../types/config";
import type { PluginPaneSettingsState, PluginResumeState } from "../../types/plugin";
import { deletePluginPaneStateValue, setPluginPaneStateValue } from "../pane-state";

export class RegistryResumeStateListeners {
  private listeners = new Map<string, Set<() => void>>();

  emit(pluginId: string, key: string): void {
    const listenerKey = `${pluginId}:${key}`;
    for (const listener of this.listeners.get(listenerKey) ?? []) {
      listener();
    }
  }

  subscribe(pluginId: string, key: string, listener: () => void): () => void {
    const listenerKey = `${pluginId}:${key}`;
    if (!this.listeners.has(listenerKey)) {
      this.listeners.set(listenerKey, new Set());
    }
    this.listeners.get(listenerKey)!.add(listener);
    return () => {
      const listeners = this.listeners.get(listenerKey);
      if (!listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(listenerKey);
      }
    };
  }

  clear(): void {
    this.listeners.clear();
  }
}

interface PluginResumeStateOptions {
  pluginId: string;
  getResumeState: <T = unknown>(key: string, schemaVersion?: number) => T | null;
  setResumeState: (key: string, value: unknown, schemaVersion?: number) => void;
  deleteResumeState: (key: string) => void;
  getPaneRuntimeState: (paneId: string) => PaneRuntimeState | null;
  updatePaneRuntimeState: (paneId: string, patch: Partial<PaneRuntimeState>) => void;
}

interface PluginPaneSettingsStateOptions {
  getLayout: () => LayoutConfig;
  resolvePaneTarget: (paneId: string) => string | undefined;
  updateLayout: (layout: LayoutConfig) => void;
}

export function createPluginResumeState({
  pluginId,
  getResumeState,
  setResumeState,
  deleteResumeState,
  getPaneRuntimeState,
  updatePaneRuntimeState,
}: PluginResumeStateOptions): PluginResumeState {
  return {
    getState: (key, options) => getResumeState(key, options?.schemaVersion),
    setState: (key, value, options) => setResumeState(key, value, options?.schemaVersion),
    deleteState: (key) => deleteResumeState(key),
    getPaneState: <T = unknown>(paneId: string, key: string): T | null => {
      const value = getPaneRuntimeState(paneId)?.pluginState?.[pluginId]?.[key];
      return value === undefined ? null : value as T;
    },
    setPaneState: (paneId, key, value) => {
      const currentPaneState = getPaneRuntimeState(paneId) ?? {};
      const pluginState = setPluginPaneStateValue(currentPaneState, pluginId, key, value);
      updatePaneRuntimeState(paneId, { pluginState });
    },
    deletePaneState: (paneId, key) => {
      const currentPaneState = getPaneRuntimeState(paneId) ?? {};
      const currentPluginState = currentPaneState.pluginState?.[pluginId];
      if (!currentPluginState || !(key in currentPluginState)) return;

      updatePaneRuntimeState(paneId, {
        pluginState: deletePluginPaneStateValue(currentPaneState, pluginId, key),
      });
    },
  };
}

export function createPluginPaneSettingsState({
  getLayout,
  resolvePaneTarget,
  updateLayout,
}: PluginPaneSettingsStateOptions): PluginPaneSettingsState {
  return {
    get: (paneId, key) => {
      const target = resolvePaneTarget(paneId);
      if (!target) return null;
      return (getLayout().instances.find((instance) => instance.instanceId === target)?.settings?.[key] as any) ?? null;
    },
    set: async (paneId, key, value) => {
      const target = resolvePaneTarget(paneId);
      if (!target) return;
      updateLayout(setPaneSetting(getLayout(), target, key, value));
    },
    delete: async (paneId, key) => {
      const target = resolvePaneTarget(paneId);
      if (!target) return;
      updateLayout(deletePaneSetting(getLayout(), target, key));
    },
  };
}
