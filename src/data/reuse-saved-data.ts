function plainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameData(saved: unknown, live: unknown, depth: number): boolean {
  if (Object.is(saved, live)) return true;
  if (!saved || !live || typeof saved !== "object" || typeof live !== "object" || depth === 0) return false;
  if (saved instanceof Date) return live instanceof Date && Object.is(saved.getTime(), live.getTime());
  if (Array.isArray(saved)) {
    return Array.isArray(live) && saved.length === live.length
      && saved.every((item, index) => sameData(item, live[index], depth - 1));
  }
  if (!plainObject(saved) || Object.getPrototypeOf(saved) !== Object.getPrototypeOf(live)
    || Object.getOwnPropertySymbols(live).length > 0) return false;
  const savedKeys = Object.keys(saved);
  const liveKeys = Object.keys(live);
  if (savedKeys.length !== liveKeys.length) return false;
  const savedFields = saved as Record<string, unknown>;
  const liveFields = live as Record<string, unknown>;
  return savedKeys.every((key, index) => key === liveKeys[index] && sameData(savedFields[key], liveFields[key], depth - 1));
}

/** Keeps derived views stable when a verified refresh has the same display data. */
export function reuseSavedData<T>(saved: T | null | undefined, live: T): T {
  return saved != null && sameData(saved, live, 32) ? saved : live;
}
