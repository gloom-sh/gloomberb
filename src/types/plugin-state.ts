import type { CachePolicy, PersistedResourceValue } from "./persistence";

export interface PluginPersistence {
  getState<T = unknown>(key: string, options?: { schemaVersion?: number }): T | null;
  setState(key: string, value: unknown, options?: { schemaVersion?: number }): void;
  deleteState(key: string): void;
  getResource<T = unknown>(
    kind: string,
    key: string,
    options?: { sourceKey?: string; schemaVersion?: number; allowExpired?: boolean },
  ): PersistedResourceValue<T> | null;
  setResource<T = unknown>(
    kind: string,
    key: string,
    value: T,
    options: {
      cachePolicy: CachePolicy;
      sourceKey?: string;
      schemaVersion?: number;
      provenance?: unknown;
    },
  ): PersistedResourceValue<T>;
  deleteResource(kind: string, key: string, options?: { sourceKey?: string }): void;
}

export interface PluginResumeState {
  getState<T = unknown>(key: string, options?: { schemaVersion?: number }): T | null;
  setState(key: string, value: unknown, options?: { schemaVersion?: number }): void;
  deleteState(key: string): void;
  getPaneState<T = unknown>(paneId: string, key: string): T | null;
  setPaneState(paneId: string, key: string, value: unknown): void;
  deletePaneState(paneId: string, key: string): void;
}

export interface PluginConfigState {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): string[];
}

export interface PluginTeamStateEntry<T> {
  value: T;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

/**
 * Plugin-owned data shared with a team, keyed per plugin. Writes take the
 * revision they expect and fail when a teammate wrote first, so nothing is
 * overwritten silently. Scoped to the active team unless a teamId is given.
 */
export interface PluginTeamState {
  activeTeamId(): string | null;
  get<T>(key: string, options?: { teamId?: string }): Promise<PluginTeamStateEntry<T> | null>;
  list<T>(options?: { teamId?: string }): Promise<Array<PluginTeamStateEntry<T> & { key: string }>>;
  set<T>(key: string, value: T, options?: { teamId?: string; expectRevision?: number }): Promise<{ revision: number }>;
  delete(key: string, options?: { teamId?: string }): Promise<void>;
  subscribe<T>(
    key: string,
    listener: (entry: PluginTeamStateEntry<T> | null) => void,
    options?: { teamId?: string },
  ): () => void;
}

export interface PluginPaneSettingsState {
  get<T = unknown>(paneId: string, key: string): T | null;
  set(paneId: string, key: string, value: unknown): Promise<void>;
  delete(paneId: string, key: string): Promise<void>;
}
