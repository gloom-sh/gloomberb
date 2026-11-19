import { expect, test } from "bun:test";
import { CachedQuery, cachedValueForDisplay, type CachedValue } from "./cached-query";
import { savedCopyAt } from "./saved-copies";

const value = (name: string, time = Date.now()): CachedValue<string> => ({
  value: name, fetchedAt: time, staleAt: time + 600_000, expiresAt: time + 3_600_000, source: "test",
});

test("a pane seeding itself from an expired query sees its age until live data replaces it", async () => {
  const expired = { ...value("expired", Date.now() - 10_000_000), value: [{ holders: 19 }] };
  const live = { ...value("live"), value: [{ holders: 20 }] };
  const query = new CachedQuery({ read: (allowExpired) => allowExpired ? expired : null, fetch: async () => live });
  const opening = cachedValueForDisplay(query.getSnapshot().result);
  expect(opening).toEqual(expired.value);
  expect(savedCopyAt(opening)).toBe(expired.fetchedAt);
  expect(savedCopyAt(expired.value)).toBeNull();
  await query.load();
  expect(cachedValueForDisplay(query.getSnapshot().result)).toBe(live.value);
  expect(savedCopyAt(live.value)).toBeNull();
});

test("a cold query checks for a saved copy only once at mount and loads on a miss", async () => {
  const reads: boolean[] = [];
  const fresh = value("live");
  const query = new CachedQuery({
    read: (allowExpired) => { reads.push(allowExpired); return null; },
    fetch: async () => fresh,
  });
  expect(reads).toEqual([true]);
  expect(query.getSnapshot().result).toBeNull();
  expect(await query.load()).toMatchObject(fresh);
  expect(reads).toEqual([true, false]);
});

test("hydration, cache reads and failed refreshes retain successful response identity", async () => {
  const seeded = value("hydrated");
  let calls = 0;
  let fail = false;
  const query = new CachedQuery({ read: () => seeded, fetch: async () => {
    calls++;
    if (fail) throw new Error("offline");
    return value(`response-${calls}`, seeded.fetchedAt);
  } });
  expect(await query.load()).toBe(seeded);
  expect(calls).toBe(0);
  expect(seeded.responseSequence).toBeUndefined();
  const first = await query.load({ force: true });
  expect(first.responseSequence).toBeGreaterThan(0);
  expect(await query.load()).toBe(first);
  fail = true;
  const refresh = query.load({ force: true });
  expect(query.getSnapshot().result).toBe(first);
  expect(query.getSnapshot().loading).toBe(true);
  const retained = await refresh;
  expect(retained.responseSequence).toBe(first.responseSequence);
  expect(query.getSnapshot().result).toBe(retained);
  expect(retained).toMatchObject({ ...first, refreshError: expect.any(Error) });
  expect(await query.load()).toBe(retained);
  expect(query.getSnapshot().error).toBeInstanceOf(Error);
  fail = false;
  const recovered = await query.load({ force: true });
  expect(recovered.fetchedAt).toBe(first.fetchedAt);
  expect(recovered.responseSequence).toBeGreaterThan(first.responseSequence!);
  expect(query.getSnapshot().error).toBeNull();
  expect(recovered.refreshError).toBeUndefined();
  expect(await query.load()).toBe(recovered);
});

test("failed cache reads keep their error without mutating hydrated or independent query data", async () => {
  const seeded = value("hydrated");
  const query = new CachedQuery({ read: () => seeded, fetch: async () => { throw new Error("offline"); } });
  const independent = new CachedQuery({ read: () => seeded });
  await query.load({ force: true });
  expect((await query.load()).refreshError).toBeInstanceOf(Error);
  expect((await independent.load()).refreshError).toBeUndefined();
  expect(seeded.refreshError).toBeUndefined();
  const reopened = new CachedQuery({ read: () => seeded });
  expect(await reopened.load()).toBe(seeded);
});

test("expired fallbacks retain source age and a superseded failure cannot restore an old error", async () => {
  const expired = value("expired", Date.now() - 10_000_000);
  let calls = 0;
  const query = new CachedQuery({ read: (allowExpired) => allowExpired ? expired : null, fetch: async () => {
    calls++;
    throw new Error("offline");
  } });
  expect(query.getSnapshot()).toMatchObject({ result: expired, loading: false });
  const refreshing = query.load();
  expect(query.getSnapshot()).toMatchObject({ result: expired, loading: true });
  const fallback = await refreshing;
  expect(fallback).toMatchObject({ fetchedAt: expired.fetchedAt, expiresAt: expired.expiresAt, refreshError: expect.any(Error) });
  await query.load();
  expect(calls).toBe(2);
  let rejectOld!: (error: Error) => void;
  const old = query.load({ force: true, fetch: () => new Promise((_, reject) => { rejectOld = reject; }) });
  await Promise.resolve();
  const current = await query.load({ force: true, replace: true, fetch: async () => value("recovered") });
  rejectOld(new Error("late obsolete failure"));
  await old;
  expect(await query.load()).toBe(current);
  expect(query.getSnapshot().error).toBeNull();
  expect(current.refreshError).toBeUndefined();
});

test("cross-query order follows accepted completion, excluding superseded and disposed results", async () => {
  const pending: Array<(result: CachedValue<string>) => void> = [];
  const query = new CachedQuery({ read: () => null, fetch: () => new Promise<CachedValue<string>>((resolve) => pending.push(resolve)) });
  const first = query.load(); await Promise.resolve();
  const replacement = query.load({ force: true, replace: true }); await Promise.resolve();
  const time = Date.now();
  pending[1]!(value("accepted", time));
  const accepted = await replacement;
  pending[0]!(value("superseded", time));
  expect((await first).responseSequence).toBeUndefined();
  expect(query.getSnapshot().result).toBe(accepted);
  const disposedRequest = query.load({ force: true }); await Promise.resolve();
  query.dispose(); pending[2]!(value("disposed", time));
  expect((await disposedRequest).responseSequence).toBeUndefined();
  expect(query.getSnapshot().result).toBe(accepted);
  const peer = new CachedQuery({ read: () => null, fetch: async () => value("peer", time) });
  const later = await peer.load();
  expect(later.fetchedAt).toBe(accepted.fetchedAt);
  expect(later.responseSequence).toBe(accepted.responseSequence! + 1);
});
