import { ApiRequestError } from "./errors";
import type { TeamPluginStateEntry, TeamView } from "./types";

type CloudApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

/** A write refused because the server holds a newer revision. */
export class TeamRevisionConflictError extends Error {
  constructor(
    message: string,
    public readonly currentRevision: number,
    public readonly current: unknown = null,
  ) {
    super(message);
    this.name = "TeamRevisionConflictError";
  }
}

function ifMatch(revision: number | undefined): Record<string, string> {
  return revision ? { "if-match": String(revision) } : {};
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
    try {
      return await this.request<TeamView>(`/views/${encodeURIComponent(viewId)}`, {
        method: "PUT",
        headers: ifMatch(input.expectedRevision),
        body: JSON.stringify({ spec: input.spec, ...(input.name ? { name: input.name } : {}) }),
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 412) {
        const current = await this.getTeamView(viewId).catch(() => null);
        throw new TeamRevisionConflictError(error.message, current?.revision ?? input.expectedRevision + 1, current);
      }
      throw error;
    }
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
    try {
      return await this.request<TeamPluginStateEntry>(
        `/teams/${encodeURIComponent(teamId)}/plugin-state/${encodeURIComponent(pluginId)}/${encodeURIComponent(key)}`,
        { method: "PUT", headers: ifMatch(expectedRevision), body: JSON.stringify({ value }) },
      );
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 412) {
        const current = await this.getTeamPluginState(teamId, pluginId, key).catch(() => null);
        throw new TeamRevisionConflictError(error.message, current?.revision ?? (expectedRevision ?? 0) + 1, current);
      }
      throw error;
    }
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
