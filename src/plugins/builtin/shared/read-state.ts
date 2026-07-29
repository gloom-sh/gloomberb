import { useCallback, useMemo } from "react";
import { usePluginState } from "../../runtime";

export const DEFAULT_MAX_READ_IDS = 2_000;

export interface PersistedReadIdAdapter<TState> {
  getIds(state: TState): readonly unknown[] | undefined;
  withIds(state: TState, ids: string[]): TState;
  maxIds?: number;
}

interface UsePersistedReadIdsOptions<TState> {
  key: string;
  fallback: TState;
  schemaVersion: number;
  adapter: PersistedReadIdAdapter<TState>;
}

function normalizeReadId(readId: unknown): string {
  return typeof readId === "string" ? readId.trim() : "";
}

function sameStringArray(left: readonly string[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function normalizeReadIds(
  readIds: readonly unknown[] | undefined,
  maxIds = DEFAULT_MAX_READ_IDS,
): string[] {
  const seen = new Set<string>();
  const normalizedIds: string[] = [];

  for (const rawId of readIds ?? []) {
    const readId = normalizeReadId(rawId);
    if (!readId || seen.has(readId)) continue;
    seen.add(readId);
    normalizedIds.push(readId);
    if (normalizedIds.length >= maxIds) break;
  }

  return normalizedIds;
}

function markReadId(
  readIds: readonly unknown[] | undefined,
  readId: string,
  maxIds = DEFAULT_MAX_READ_IDS,
): string[] {
  const normalizedId = normalizeReadId(readId);
  const current = normalizeReadIds(readIds, maxIds);
  if (!normalizedId) return current;

  return [
    normalizedId,
    ...current.filter((currentId) => currentId !== normalizedId),
  ].slice(0, maxIds);
}

export function normalizePersistedReadIdState<TState>(
  state: TState,
  adapter: PersistedReadIdAdapter<TState>,
): TState {
  const current = adapter.getIds(state);
  const ids = normalizeReadIds(current, adapter.maxIds);
  return Array.isArray(current) && sameStringArray(ids, current)
    ? state
    : adapter.withIds(state, ids);
}

export function markPersistedReadId<TState>(
  state: TState,
  readId: string,
  adapter: PersistedReadIdAdapter<TState>,
): TState {
  const current = adapter.getIds(state);
  const ids = markReadId(current, readId, adapter.maxIds);
  return Array.isArray(current) && sameStringArray(ids, current)
    ? state
    : adapter.withIds(state, ids);
}

export function usePersistedReadIds<TState>({
  key,
  fallback,
  schemaVersion,
  adapter,
}: UsePersistedReadIdsOptions<TState>) {
  const [state, setState] = usePluginState<TState>(key, fallback, { schemaVersion });
  const normalizedState = useMemo(
    () => normalizePersistedReadIdState(state, adapter),
    [adapter, state],
  );
  const readIds = useMemo(
    () => new Set(normalizeReadIds(adapter.getIds(normalizedState), adapter.maxIds)),
    [adapter, normalizedState],
  );
  const markRead = useCallback((readId: string) => {
    setState((current) => markPersistedReadId(current, readId, adapter));
  }, [adapter, setState]);

  return { readIds, markRead };
}
