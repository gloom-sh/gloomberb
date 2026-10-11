/**
 * What the free preview of a Pro function says in place of a bare "requires
 * Gloom Pro": what the free rows are, what Pro adds and when its history
 * starts. Each clause comes from the response; one the response cannot back
 * is left out rather than guessed. The line names Gloom Pro, so reports print
 * it as the lock it is (under "Pro") and a bot-safe check still calls it one.
 */
export interface FreePreviewNote {
  /** What the free rows are, after "Free shows": `3 of 6 KPI values`, `the 3 latest awards`. */
  shows: string;
  /** What Pro adds, after "Gloom Pro adds": `the other 3`. Left out, the line says "the rest". */
  adds?: string | null;
  /** The first day Pro's history covers, as YYYY-MM-DD or an ISO instant. */
  historyFrom?: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Oct 2024", the way report lines write a day; null for anything that is not a date. */
function day(value: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== match[0]) return null;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "Free shows 3 of 6 KPI values. Gloom Pro adds the other 3, with history from 31 Dec 2024." */
export function freePreviewNote({ shows, adds, historyFrom }: FreePreviewNote): string {
  const since = day(historyFrom);
  return `Free shows ${shows}. Gloom Pro adds ${adds?.trim() || "the rest"}${since ? `, with history from ${since}` : ""}.`;
}

/** "3 awards", "1 award", "no earnings calls": a count as a sentence says it. */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return count === 0 ? `no ${plural}` : `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

/**
 * "the preview can't filter by ticker", "... by ticker or country": the same
 * words wherever a preview shows the same rows whatever was asked for.
 */
export function previewCantFilter(filters: readonly string[]): string {
  const names = [...new Set(filters)];
  if (!names.length) return "the preview can't filter";
  return `the preview can't filter by ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`}`;
}
