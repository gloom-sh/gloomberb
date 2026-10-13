import { apiClient, type TeamPluginStateEntry, type TeamPluginStateEvent } from "../../../../api-client";
import { setTeamStateHost, type TeamStateHost } from "../../../team-state";
import { teamStore } from "../../../../team/store";

type Listener = (entry: { value: unknown; revision: number; updatedBy: string; updatedAt: string } | null) => void

function key(teamId: string, pluginId: string, key: string): string {
  return `${teamId}\u0000${pluginId}\u0000${key}`;
}

function publicEntry(entry: TeamPluginStateEntry) {
  return { value: entry.value, revision: entry.revision, updatedBy: entry.updatedBy, updatedAt: entry.updatedAt };
}

/**
 * Backs `ctx.teamState` with the team_plugin_state routes. Subscriptions ride
 * the plugin-state.updated frame, which carries the new value, so a change by
 * a teammate reaches every listener without a refetch.
 */
export function installTeamStateHost(): () => void {
  const listeners = new Map<string, Set<Listener>>();
  const unsubscribe = apiClient.subscribeCloudEvent("plugin-state.updated", (data) => {
    const event = data as TeamPluginStateEvent;
    if ("state" in event) {
      const targets = listeners.get(key(event.teamId, event.state.pluginId, event.state.key));
      if (targets) for (const listener of targets) listener(publicEntry(event.state));
      return;
    }
    const targets = listeners.get(key(event.teamId, event.pluginId, event.key));
    if (targets) for (const listener of targets) listener(null);
  });

  const host: TeamStateHost = {
    activeTeamId: () => {
      const focused = teamStore.getDefaultTeamId();
      if (focused) return focused;
      const teams = teamStore.getSnapshot().teams;
      return teams.length === 1 ? teams[0]!.id : null;
    },
    async get(teamId, pluginId, stateKey) {
      const entry = await apiClient.getTeamPluginState(teamId, pluginId, stateKey);
      return entry ? publicEntry(entry) : null;
    },
    async list(teamId, pluginId) {
      const entries = await apiClient.listTeamPluginState(teamId, pluginId);
      return entries.map((entry) => ({ key: entry.key, ...publicEntry(entry) }));
    },
    async set(teamId, pluginId, stateKey, value, expectRevision) {
      return publicEntry(await apiClient.putTeamPluginState(teamId, pluginId, stateKey, value, expectRevision));
    },
    async delete(teamId, pluginId, stateKey) {
      await apiClient.deleteTeamPluginState(teamId, pluginId, stateKey);
    },
    subscribe(teamId, pluginId, stateKey, listener) {
      const id = key(teamId, pluginId, stateKey);
      const set = listeners.get(id) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(id, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(id);
      };
    },
  };
  setTeamStateHost(host);
  return () => {
    unsubscribe();
    setTeamStateHost(null);
  };
}
