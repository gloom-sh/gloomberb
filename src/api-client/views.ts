import { ApiRequestError, RevisionConflictError } from "./errors";
import { putWithRevision, type CloudApiRequest } from "./request";
import type { TeamPluginStateEntry, TeamView } from "./types";

/** A write refused because the server holds a newer revision. */
export class TeamRevisionConflictError<T = unknown> extends RevisionConflictError<T> {
  override name = "TeamRevisionConflictError";
}

export class CloudViewsApi {
  constructor(private readonly request: CloudApiRequest) {}

  async listTeamViews(teamId: string): Promise<TeamView[]> {
    const body = await this.request<{ items?: TeamView[] }>(`/teams/${encodeURIComponent(teamId)}/views`);
    return Array.isArray(body?.items) ? body.items : [];
  }

  async getTeamView(viewId: string): Promise<TeamView | null> {
    try {
      return await this.request<TeamView>(`/views/${encodeURIComponent(viewId)}`);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return null;
      throw error;
    }
  }

  async createTeamView(teamId: string, input: { name: string; spec: Record<string, unknown> }): Promise<TeamView> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/views`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async publishTeamViewRevision(
    viewId: string,
    input: { spec: Record<string, unknown>; name?: string; expectedRevision: number },
  ): Promise<TeamView> {
    return putWithRevision<TeamView, TeamView>(this.request, `/views/${encodeURIComponent(viewId)}`, {
      spec: input.spec,
      ...(input.name ? { name: input.name } : {}),
    }, {
      expected: input.expectedRevision,
      loadCurrent: () => this.getTeamView(viewId),
      conflict: TeamRevisionConflictError,
    });
  }

  // Plugin state

  async listTeamPluginState(teamId: string, pluginId: string): Promise<TeamPluginStateEntry[]> {
    const body = await this.request<{ items: TeamPluginStateEntry[] }>(
      `/teams/${encodeURIComponent(teamId)}/plugin-state/${encodeURIComponent(pluginId)}`,
    );
    return body.items;
  }

  async getTeamPluginState(teamId: string, pluginId: string, key: string): Promise<TeamPluginStateEntry | null> {
    try {
      return await this.request<TeamPluginStateEntry>(
        `/teams/${encodeURIComponent(teamId)}/plugin-state/${encodeURIComponent(pluginId)}/${encodeURIComponent(key)}`,
      );
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return null;
      throw error;
    }
  }

  async putTeamPluginState(
    teamId: string,
    pluginId: string,
    key: string,
    value: unknown,
    expectedRevision?: number,
  ): Promise<TeamPluginStateEntry> {
    return putWithRevision<TeamPluginStateEntry, TeamPluginStateEntry>(
      this.request,
      `/teams/${encodeURIComponent(teamId)}/plugin-state/${encodeURIComponent(pluginId)}/${encodeURIComponent(key)}`,
      { value },
      {
        expected: expectedRevision,
        loadCurrent: () => this.getTeamPluginState(teamId, pluginId, key),
        conflict: TeamRevisionConflictError,
      },
    );
  }

  async deleteTeamPluginState(teamId: string, pluginId: string, key: string): Promise<void> {
    try {
      await this.request(
        `/teams/${encodeURIComponent(teamId)}/plugin-state/${encodeURIComponent(pluginId)}/${encodeURIComponent(key)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return;
      throw error;
    }
  }
}
