/**
 * Parses an SEC acceptance time only when it names its timezone. Compact
 * wall-clock values such as "20240802120000" carry none, so they stay
 * unparsed and callers keep the source value separately.
 */
export function parseSecAcceptanceTime(value: unknown): Date | undefined {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return undefined;
  const timestamp = new Date(text);
  return Number.isFinite(timestamp.getTime()) ? timestamp : undefined;
}
