/**
 * Answers given from a copy saved earlier because refreshing it failed:
 * offline, a hung or refused proxy, a service error.
 *
 * A CLI command answers once, so the line it ends with says "couldn't
 * refresh; saved copy from <time>" instead of reading as live or delayed, but
 * only when what it shows came from such a copy: a saved copy of something
 * else it loaded on the way (a fallback for a pane it does not print) says
 * nothing about the data on screen. The app says the same in the footer of a
 * pane showing such a copy (`savedCopyAt`), until a refresh replaces it.
 *
 * The copy served is marked, by a symbol property that object spreads carry
 * along and JSON never writes, and the command's output is searched for the
 * marks. A value built from a newer answer must not inherit a mark through a
 * spread: `withSavedCopyMarkOf` gives it the mark of what was served instead.
 */
const SAVED_AT = Symbol("gloomberb.savedCopyAt");

let collecting = 0;
/** Whether anything was ever marked, so output is not searched for marks that cannot be there. */
let anyMarked = false;

type Marked = { [SAVED_AT]?: number };

function mark<T>(value: T, savedAt: number): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  anyMarked = true;
  return { ...value, [SAVED_AT]: savedAt };
}

/**
 * The value answered with when it came from a copy saved at `savedAt` (ms)
 * after its refresh failed: a marked copy. An array's items are marked one by
 * one, since a report shows its rows rather than the array that held them.
 */
export function servedFromSavedCopy<T>(value: T, savedAt: number): T {
  if (!Number.isFinite(savedAt) || !value || typeof value !== "object") return value;
  return (Array.isArray(value) ? value.map((item) => mark(item, savedAt)) : mark(value, savedAt)) as T;
}

/**
 * The saved-copy mark of `value`, to spread into what is drawn from it (a
 * report row built from a quote's fields), or nothing when it has none.
 */
export function savedCopyMark(value: unknown): object {
  const savedAt = savedCopyAt(value);
  return savedAt != null ? { [SAVED_AT]: savedAt } : {};
}

/** When `value` itself was saved, if it is a saved copy served after a failed refresh; null otherwise. */
export function savedCopyAt(value: unknown): number | null {
  const savedAt = value && typeof value === "object" ? (value as Marked)[SAVED_AT] : undefined;
  return typeof savedAt === "number" ? savedAt : null;
}

/** The oldest saved copy among `values` (a pane's quotes), by when it was saved; null when none is one. */
export function oldestSavedCopyAt(values: Iterable<unknown>): number | null {
  let oldest: number | null = null;
  for (const value of values) {
    const savedAt = savedCopyAt(value);
    if (savedAt != null) oldest = Math.min(oldest ?? savedAt, savedAt);
  }
  return oldest;
}

/**
 * `value` carrying the saved-copy mark of `served` and no other: what is
 * built from an answer (resolved, merged onto an older quote) is a saved copy
 * exactly when that answer was.
 */
export function withSavedCopyMarkOf<T extends object>(value: T, served: unknown): T {
  const savedAt = savedCopyAt(served);
  const own = savedCopyAt(value);
  if (own === savedAt) return value;
  if (savedAt != null) return mark(value, savedAt);
  const { [SAVED_AT]: _dropped, ...rest } = value as T & Marked;
  return rest as T;
}

/** How far into a command's output the marks are looked for, so a large report is not walked whole. */
const MAX_DEPTH = 6;
const MAX_NODES = 50_000;

/**
 * When the oldest saved copy among `shown` (what a command prints, or the
 * data its closing line is drawn from) was saved, or null when none of it
 * came from one. The oldest, since that is how old what is shown can be.
 */
export function savedCopyShownAt(shown: unknown): number | null {
  if (collecting === 0 || !anyMarked) return null;
  let oldest: number | null = null;
  let budget = MAX_NODES;
  const seen = new Set<object>();
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || seen.has(node) || budget-- <= 0) return;
    seen.add(node);
    const savedAt = (node as Marked)[SAVED_AT];
    if (typeof savedAt === "number") oldest = oldest == null ? savedAt : Math.min(oldest, savedAt);
    if (depth >= MAX_DEPTH) return;
    for (const child of Array.isArray(node) ? node : Object.values(node)) visit(child, depth + 1);
  };
  visit(shown, 0);
  return oldest;
}

/** Runs one command, whose output `savedCopyShownAt` then searches for saved copies. */
export async function collectSavedCopies<T>(run: () => Promise<T>): Promise<T> {
  collecting += 1;
  try {
    return await run();
  } finally {
    collecting -= 1;
  }
}
