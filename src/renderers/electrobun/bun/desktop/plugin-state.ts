import type { PluginRegistry } from "../../../../plugins/registry";
import type { PersistedAuthUser } from "../../../../api-client";
import { apiClient } from "../../../../api-client";
import type { DesktopPluginStateRequest, DesktopPluginStateSetEntry } from "../../shared/protocol";

interface PluginStateBackendStore {
  set(pluginId: string, key: string, value: unknown, schemaVersion?: number): void;
  setMany(entries: DesktopPluginStateSetEntry[]): void;
  delete(pluginId: string, key: string): void;
}

interface PersistedCloudSession {
  sessionToken?: string | null;
  user?: PersistedAuthUser | null;
}

function normalizePluginStateSetEntry(entry: unknown): DesktopPluginStateSetEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.pluginId !== "string" || typeof record.key !== "string") return null;
  return {
    pluginId: record.pluginId,
    key: record.key,
    value: record.value,
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : undefined,
  };
}

function syncBackendCloudAuthState(pluginId: string, key: string, value: unknown): void {
  if (pluginId !== "gloomberb-cloud" || (key !== "session" && key !== "resume:session")) return;

  const session = value && typeof value === "object" ? value as PersistedCloudSession : null;
  const token = typeof session?.sessionToken === "string" && session.sessionToken.length > 0
    ? session.sessionToken
    : null;

  apiClient.setSessionToken(token);
  apiClient.setWebSocketToken(null);
  apiClient.restoreCachedUser(token ? session?.user ?? null : null);
}

export function handleDesktopPluginStateRequest(
  store: PluginStateBackendStore,
  request: DesktopPluginStateRequest,
): null {
  switch (request.method) {
    case "pluginState.set": {
      const { pluginId, key, value, schemaVersion } = request.payload;
      store.set(pluginId, key, value, schemaVersion);
      syncBackendCloudAuthState(pluginId, key, value);
      return null;
    }
    case "pluginState.setMany": {
      const entries = Array.isArray(request.payload.entries)
        ? request.payload.entries.flatMap((entry) => {
            const normalized = normalizePluginStateSetEntry(entry);
            return normalized ? [normalized] : [];
          })
        : [];
      store.setMany(entries);
      for (const entry of entries) {
        syncBackendCloudAuthState(entry.pluginId, entry.key, entry.value);
      }
      return null;
    }
    case "pluginState.delete": {
      const { pluginId, key } = request.payload;
      store.delete(pluginId, key);
      syncBackendCloudAuthState(pluginId, key, null);
      return null;
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown plugin state method: ${String(exhaustive)}`);
    }
  }
}

export function loadDesktopPluginState(registry: PluginRegistry): Record<string, Record<string, unknown>> {
  const state: Record<string, Record<string, unknown>> = {};
  for (const pluginId of registry.allPlugins.keys()) {
    const keys = registry.persistence.pluginState.keys(pluginId);
    if (keys.length === 0) continue;
    state[pluginId] = {};
    for (const key of keys) {
      const record = registry.persistence.pluginState.get(pluginId, key);
      if (record) state[pluginId]![key] = record.value;
    }
  }
  return state;
}
