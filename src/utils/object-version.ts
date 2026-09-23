const objectVersions = new WeakMap<object, number>();
let nextObjectVersion = 1;

/**
 * Identity version of a record that is replaced rather than mutated: the same
 * object always gets the same number and a new object a new one, so a cache or
 * a memoized row can key on it without holding the object.
 */
export function objectVersion(value: object | null | undefined): number {
  if (!value) return 0;
  const existing = objectVersions.get(value);
  if (existing != null) return existing;
  const next = nextObjectVersion;
  nextObjectVersion += 1;
  objectVersions.set(value, next);
  return next;
}
