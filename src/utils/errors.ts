/** The message of a thrown Error, or `fallback` (or `String(error)` when omitted). */
export function errorMessage(error: unknown, fallback?: string): string {
  if (fallback !== undefined) return error instanceof Error && error.message ? error.message : fallback;
  return error instanceof Error ? error.message : String(error);
}
