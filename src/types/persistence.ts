
export interface CachePolicy {
  staleMs: number;
  expireMs: number;
}

export type CachePolicyMap = Partial<Record<string, CachePolicy>>;

interface PersistedResourceMetadata {
  fetchedAt: number;
  staleAt: number;
  expiresAt: number;
  sourceKey: string;
  schemaVersion: number;
}

export interface PersistedResourceValue<T = unknown> extends PersistedResourceMetadata {
  value: T;
  provenance?: unknown | null;
  stale?: boolean;
  expired?: boolean;
  /** The caller must refresh even if this copy has not expired. */
  fallbackOnly?: true;
}
