/**
 * Answers a CLI command gave from a copy saved earlier because refreshing it
 * failed: offline, a refused proxy, a service error. A command answers once,
 * so the line it ends with says "couldn't refresh; saved <time>" instead of
 * reading as live or delayed, but only when what it shows came from such a
 * copy: a saved copy of something else it loaded on the way (a fallback for a
 * pane it does not print) says nothing about the data on screen.
 *
 * The copy served is marked, by a symbol property that object spreads carry
 * along and JSON never writes, and the command's output is searched for the
 * marks. Nothing is marked outside `collectSavedCopies`: the app and its panes
 * keep running for hours and say how current their data is in their own
 * footers.
 */
const SAVED_AT = Symbol("gloomberb.savedCopyAt");

let collecting = 0;
let marked = 0;

type Marked = { [SAVED_AT]?: number };

function mark<T>(value: T, savedAt: number): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  marked += 1;
  return { ...value, [SAVED_AT]: savedAt };
}

/**
 * The value a command answers with when it came from a copy saved at
 * `savedAt` (ms) after its refresh failed: a marked copy while a command runs,
 * the value itself otherwise. An array's items are marked one by one, since
 * a report shows its rows rather than the array that held them.
 */
export function servedFromSavedCopy<T>(value: T, savedAt: number): T {
  if (collecting === 0 || !Number.isFinite(savedAt) || !value || typeof value !== "object") return value;
  return (Array.isArray(value) ? value.map((item) => mark(item, savedAt)) : mark(value, savedAt)) as T;
}

/**
 * The saved-copy mark of `value`, to spread into what is drawn from it (a
 * report row built from a quote's fields), or nothing when it has none.
 */
export function savedCopyMark(value: unknown): object {
  const savedAt = value && typeof value === "object" ? (value as Marked)[SAVED_AT] : undefined;
  return typeof savedAt === "number" ? { [SAVED_AT]: savedAt } : {};
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
  if (collecting === 0 || marked === 0) return null;
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

/** Runs one command, marking the saved copies it answers from. */
export async function collectSavedCopies<T>(run: () => Promise<T>): Promise<T> {
  if (collecting === 0) marked = 0;
  collecting += 1;
  try {
    return await run();
  } finally {
    collecting -= 1;
    if (collecting === 0) marked = 0;
  }
}
