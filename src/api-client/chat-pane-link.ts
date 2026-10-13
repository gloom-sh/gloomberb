/**
 * What a chat message opens in the terminal beside its text, as the server
 * sends it: the news story a Gloom Wire headline names, the calendar a morning
 * post reads from. Only the server writes it, from ids it already resolved.
 * A kind this version does not know, or a malformed one, reads as absent and
 * the message is plain text, as it is for a server that predates the field.
 */
export type ChatPaneLink =
  | { kind: "news-story"; storyId: string }
  | { kind: "economic-calendar"; date: string }
  | { kind: "earnings-calendar"; date: string }
  | { kind: "ipo-calendar"; date: string }
  | { kind: "energy-report"; report: "petroleum" | "gas"; weekEnding: string };

const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATED_KINDS: ReadonlySet<string> = new Set(["economic-calendar", "earnings-calendar", "ipo-calendar"]);

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}

export function parseChatPaneLink(value: unknown): ChatPaneLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const link = value as Record<string, unknown>;
  const keys = Object.keys(link).sort().join(",");
  if (link.kind === "news-story") {
    return keys === "kind,storyId" && typeof link.storyId === "string" && STORY_ID.test(link.storyId)
      ? { kind: "news-story", storyId: link.storyId }
      : null;
  }
  if (typeof link.kind === "string" && DATED_KINDS.has(link.kind)) {
    return keys === "date,kind" && isCalendarDate(link.date)
      ? { kind: link.kind, date: link.date } as ChatPaneLink
      : null;
  }
  if (link.kind === "energy-report") {
    return keys === "kind,report,weekEnding"
      && (link.report === "petroleum" || link.report === "gas")
      && isCalendarDate(link.weekEnding)
      ? { kind: "energy-report", report: link.report, weekEnding: link.weekEnding }
      : null;
  }
  return null;
}
