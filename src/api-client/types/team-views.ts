// Team views and plugin state

export interface TeamView {
  id: string;
  teamId: string;
  name: string;
  revision: number;
  spec: Record<string, unknown>;
  createdBy: string;
  author: { username: string | null; displayName: string };
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
}

export type TeamViewEvent =
  | { teamId: string; actorId: string; view: TeamView }
  | { teamId: string; actorId: string; viewId: string };

export interface TeamPluginStateEntry {
  teamId: string;
  pluginId: string;
  key: string;
  value: unknown;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

export type TeamPluginStateEvent =
  | { teamId: string; actorId: string; state: TeamPluginStateEntry }
  | { teamId: string; actorId: string; pluginId: string; key: string; deleted: true };
