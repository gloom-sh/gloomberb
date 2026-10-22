/**
 * Answers a CLI command gave from a copy saved earlier because refreshing it
 * failed: offline, a refused proxy, a service error. A command answers once,
 * so the line it ends with says "couldn't refresh; saved <time>" instead of
 * reading as live or delayed when anything it shows came from one. Only the
 * oldest save is kept: that is how old the answer can be.
 *
 * Nothing is recorded outside `collectSavedCopies`: the app and its panes keep
 * running for hours and say how current their data is in their own footers.
 */
let collecting = 0;
let oldestSavedAt: number | null = null;

/** Records an answer served from a copy saved at `savedAt` (ms) after its refresh failed. */
export function noteSavedCopyServed(savedAt: number): void {
  if (collecting === 0 || !Number.isFinite(savedAt)) return;
  oldestSavedAt = oldestSavedAt == null ? savedAt : Math.min(oldestSavedAt, savedAt);
}

/** When the oldest saved copy the running command answered from was saved, or null when every answer was fresh. */
export function savedCopyServedAt(): number | null {
  return collecting > 0 ? oldestSavedAt : null;
}

/** Runs one command, recording the saved copies it answers from. */
export async function collectSavedCopies<T>(run: () => Promise<T>): Promise<T> {
  if (collecting === 0) oldestSavedAt = null;
  collecting += 1;
  try {
    return await run();
  } finally {
    collecting -= 1;
    if (collecting === 0) oldestSavedAt = null;
  }
}
