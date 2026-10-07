/**
 * Notes are what a tool row prints under its name and what Gloom reads next to
 * the result. Both want one short line: the platform refuses a result whose
 * note is too long, and a row is no place for a log.
 */
const MAX_TOOL_NOTE_LENGTH = 400;

/** Subjects named per warning group before the rest are counted. */
const LISTED_SUBJECTS = 4;

/** "ASML: Daily history unavailable", "AMD:XNAS: No kpi observations". */
const SUBJECT_WARNING = /^(\S{1,24}):\s+(.+)$/;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Drops a response body pasted into an error message ("Request failed:
 * {"type":"validation",...}"), keeping the words before it. A row says what
 * went wrong; the raw payload helps nobody reading it.
 */
function withoutRawJson(text: string): string {
  const line = oneLine(text);
  const start = line.search(/[{[]\s*"|\[\s*\{/);
  if (start < 0) return line;
  return line.slice(0, start).replace(/[\s:;,.-]+$/, "").trim();
}

/** One line of at most `maxLength` characters, ending in an ellipsis when cut. */
export function capToolNote(text: string, maxLength = MAX_TOOL_NOTE_LENGTH): string {
  const line = oneLine(text);
  if (line.length <= maxLength) return line;
  return `${line.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** A tool error as a row note: no response bodies, one capped line. */
export function toolErrorNote(error: unknown, fallback = "The tool failed."): string {
  const text = withoutRawJson(error instanceof Error ? error.message : String(error ?? ""));
  return capToolNote(text || fallback);
}

interface WarningGroup {
  message: string;
  subjects: string[];
}

function groupWarnings(warnings: readonly string[]): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  for (const raw of warnings) {
    const warning = withoutRawJson(raw);
    if (!warning) continue;
    const match = SUBJECT_WARNING.exec(warning);
    // Groups are joined with semicolons, so their own closing period goes.
    const message = (match ? match[2]! : warning).replace(/\.$/, "");
    const group = groups.get(message) ?? { message, subjects: [] };
    if (match && !group.subjects.includes(match[1]!)) group.subjects.push(match[1]!);
    groups.set(message, group);
  }
  return [...groups.values()];
}

function describeGroup({ message, subjects }: WarningGroup): string {
  if (subjects.length === 0) return message;
  if (subjects.length === 1) return `${subjects[0]}: ${message}`;
  const listed = subjects.slice(0, LISTED_SUBJECTS).join(", ");
  const rest = subjects.length - LISTED_SUBJECTS;
  return `${message} (${listed}${rest > 0 ? ` and ${rest} more` : ""})`;
}

/**
 * Warnings as one note: repeated messages grouped across their symbols, the
 * first groups that fit, and a count of the groups left out.
 */
export function summarizeToolWarnings(
  warnings: readonly string[],
  maxLength = MAX_TOOL_NOTE_LENGTH,
): string {
  const parts = groupWarnings(warnings).map(describeGroup);
  if (parts.length === 0) return "";
  const kept: string[] = [];
  for (const [index, part] of parts.entries()) {
    const left = parts.length - index - 1;
    const suffix = left > 0 ? `; and ${left} more` : "";
    const candidate = [...kept, part].join("; ");
    if (candidate.length + suffix.length > maxLength) break;
    kept.push(part);
  }
  if (kept.length === 0) return capToolNote(parts[0]!, maxLength);
  const left = parts.length - kept.length;
  return capToolNote(`${kept.join("; ")}${left > 0 ? `; and ${left} more` : ""}`, maxLength);
}

/** Two notes in one, the second (usually what the client did) always kept whole. */
export function joinToolNotes(first: string | undefined, second: string, maxLength = MAX_TOOL_NOTE_LENGTH): string {
  const tail = capToolNote(second, maxLength);
  if (!first) return tail;
  const room = maxLength - tail.length - 1;
  return room > 20 ? `${capToolNote(first, room)} ${tail}` : tail;
}
