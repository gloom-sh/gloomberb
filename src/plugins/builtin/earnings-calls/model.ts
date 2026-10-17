import type {
  CloudEarningsCallPayload,
  CloudEarningsTranscriptPayload,
  CloudTranscriptTurnPayload,
} from "../../../api-client";
import { splitParagraphs } from "./prose";

export type TranscriptSection =
  | "overview"
  | "summary"
  | "transcript"
  | "qa"
  | "guidance"
  | "risks"
  | "notable"
  | "analyst-focus"
  | "participants";

export interface TranscriptFilter {
  section: "transcript" | "qa";
  speaker?: string;
  search?: string;
}

export interface TranscriptSegment {
  index: number;
  section: string;
  startSeconds: number | null;
  speaker: string | null;
  role: string | null;
  company: string | null;
  isQa: boolean;
  text: string;
}

const MAX_SEGMENT_CHARS = 1_600;

function roleAcronym(value: string): string {
  return value
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]/.test(word))
    .map((word) => word[0])
    .join("");
}

function turnSpeakerText(turn: CloudTranscriptTurnPayload): string {
  const role = turn.role ?? "";
  return [
    turn.speaker,
    role,
    roleAcronym(role),
    turn.company ?? "",
  ].join(" ").toLowerCase();
}

function turnSearchText(turn: CloudTranscriptTurnPayload): string {
  return `${turnSpeakerText(turn)} ${turn.text}`.toLowerCase();
}

export function filterTranscriptTurns(
  turns: CloudTranscriptTurnPayload[],
  filter: TranscriptFilter,
): CloudTranscriptTurnPayload[] {
  const speaker = filter.speaker?.trim().toLowerCase() ?? "";
  const search = filter.search?.trim().toLowerCase() ?? "";
  return turns.filter((turn) => {
    if (filter.section === "qa" && !turn.isQa) return false;
    if (speaker && !turnSpeakerText(turn).includes(speaker)) return false;
    return !search || turnSearchText(turn).includes(search);
  });
}

function chunks(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const result: string[] = [];
  let remaining = normalized;
  while (remaining.length > MAX_SEGMENT_CHARS) {
    const breakAt = Math.max(
      remaining.lastIndexOf(" ", MAX_SEGMENT_CHARS),
      remaining.lastIndexOf("\n", MAX_SEGMENT_CHARS),
    );
    const cut = breakAt > MAX_SEGMENT_CHARS / 2 ? breakAt : MAX_SEGMENT_CHARS;
    result.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) result.push(remaining);
  return result;
}

function summaryFields(
  transcript: CloudEarningsTranscriptPayload,
  section: TranscriptSection,
): Array<{ section: string; text: string }> {
  const fields = [
    { section: "summary", text: transcript.summary ?? "" },
    { section: "notable", text: transcript.notable ?? "" },
    { section: "analyst-focus", text: transcript.analystFocus ?? "" },
    { section: "guidance", text: transcript.guidance ?? "" },
    { section: "risks", text: transcript.riskFactors ?? "" },
  ];
  return section === "overview"
    ? fields.filter((field) => field.text.trim())
    : fields.filter((field) => field.section === section && field.text.trim());
}

export function buildTranscriptSegments(
  transcript: CloudEarningsTranscriptPayload,
  section: TranscriptSection,
  options: { speaker?: string; search?: string } = {},
): TranscriptSegment[] {
  const withoutIndexes: Array<Omit<TranscriptSegment, "index">> = [];

  if (section === "transcript" || section === "qa") {
    const turns = filterTranscriptTurns(transcript.turns ?? [], {
      section,
      speaker: options.speaker,
      search: options.search,
    });
    for (const turn of turns) {
      for (const text of chunks(turn.text)) {
        withoutIndexes.push({
          section,
          startSeconds: turn.startSeconds,
          speaker: turn.speaker,
          role: turn.role ?? null,
          company: turn.company ?? null,
          isQa: turn.isQa,
          text,
        });
      }
    }
    if (withoutIndexes.length === 0 && section === "transcript" && transcript.fullText.trim()) {
      const search = options.search?.trim().toLowerCase() ?? "";
      if (!options.speaker?.trim() && (!search || transcript.fullText.toLowerCase().includes(search))) {
        for (const paragraph of transcript.fullText.split(/\n{2,}/)) {
          if (search && !paragraph.toLowerCase().includes(search)) continue;
          for (const text of chunks(paragraph)) {
            withoutIndexes.push({
              section,
              startSeconds: null,
              speaker: null,
              role: null,
              company: null,
              isQa: false,
              text,
            });
          }
        }
      }
    }
  } else if (section === "participants") {
    const speaker = options.speaker?.trim().toLowerCase() ?? "";
    for (const participant of transcript.participants) {
      const haystack = [
        participant.name,
        participant.role ?? "",
        roleAcronym(participant.role ?? ""),
        participant.company ?? "",
      ].join(" ").toLowerCase();
      if (speaker && !haystack.includes(speaker)) continue;
      withoutIndexes.push({
        section,
        startSeconds: null,
        speaker: participant.name,
        role: participant.role ?? null,
        company: participant.company ?? null,
        isQa: false,
        text: [participant.role, participant.company].filter(Boolean).join(", "),
      });
    }
  } else {
    for (const field of summaryFields(transcript, section)) {
      for (const text of chunks(field.text)) {
        withoutIndexes.push({
          section: field.section,
          startSeconds: null,
          speaker: null,
          role: null,
          company: null,
          isQa: false,
          text,
        });
      }
    }
  }

  return withoutIndexes.map((segment, index) => ({ index, ...segment }));
}

function callTime(call: CloudEarningsCallPayload): number {
  const timestamp = call.callAt ? Date.parse(call.callAt) : Number.NaN;
  if (Number.isFinite(timestamp)) return timestamp;
  return (call.fiscalYear ?? 0) * 10 + (call.fiscalQuarter ?? 0);
}

export function sortCallsNewest(calls: CloudEarningsCallPayload[]): CloudEarningsCallPayload[] {
  return [...calls].sort((left, right) => callTime(right) - callTime(left));
}

function sameYear(actual: number | null, requested: number | null): boolean {
  if (requested == null) return true;
  if (actual == null) return false;
  return requested < 100 ? actual % 100 === requested : actual === requested;
}

export function findCallForQuarter(
  calls: CloudEarningsCallPayload[],
  requestedQuarter: string,
): CloudEarningsCallPayload | null {
  const sorted = sortCallsNewest(calls);
  const token = requestedQuarter.trim().toUpperCase().replace(/[\s_-]+/g, "");
  if (!token || token === "LATEST") return sorted[0] ?? null;

  const quarterFirst = token.match(/^(?:F?Q)?([1-4])(?:\/?(\d{2}|\d{4}))?$/);
  if (quarterFirst) {
    const quarter = Number(quarterFirst[1]);
    const year = quarterFirst[2] ? Number(quarterFirst[2]) : null;
    return sorted.find((call) => (
      call.fiscalQuarter === quarter && sameYear(call.fiscalYear, year)
    )) ?? null;
  }

  const yearFirst = token.match(/^(\d{2}|\d{4})(?:\/?F?Q)([1-4])$/);
  if (yearFirst) {
    const year = Number(yearFirst[1]);
    const quarter = Number(yearFirst[2]);
    return sorted.find((call) => (
      call.fiscalQuarter === quarter && sameYear(call.fiscalYear, year)
    )) ?? null;
  }

  const fiscalYear = token.match(/^(?:FY)?(\d{2}|\d{4})$/);
  if (fiscalYear) {
    const year = Number(fiscalYear[1]);
    return sorted.find((call) => sameYear(call.fiscalYear, year)) ?? null;
  }

  return null;
}

/**
 * A turn as the reader shows it: the paragraphs the server cut where the
 * speaker paused, or, for a transcript from before that, cut here by length.
 */
export function turnParagraphs(turn: CloudTranscriptTurnPayload): string[] {
  return turn.paragraphs && turn.paragraphs.length > 0
    ? turn.paragraphs
    : splitParagraphs(turn.text);
}

/** A paragraph of the reader, by its turn's place in the whole transcript. */
export interface TranscriptLine {
  turn: number;
  paragraph: number;
}

/**
 * Where each paragraph starts in the recording, by turn and paragraph; null
 * for a transcript the company published as a document, which has no times.
 * The server gives the starts; a transcript held from before it did places
 * each paragraph by how far into its turn it sits, between the turn's start
 * and the next one's.
 */
export function transcriptLineStarts(
  turns: readonly CloudTranscriptTurnPayload[],
  durationSeconds: number | null,
): Array<Array<number | null>> {
  return turns.map((turn, index) => {
    const paragraphs = turnParagraphs(turn);
    const start = turn.startSeconds;
    if (start === null || !Number.isFinite(start)) return paragraphs.map(() => null);
    const given = turn.paragraphStarts;
    if (given && given.length === paragraphs.length && given.every(Number.isFinite)) return [...given];
    const next = turns.slice(index + 1).find((later) => later.startSeconds !== null && later.startSeconds > start);
    const end = next?.startSeconds ?? durationSeconds;
    const total = paragraphs.reduce((sum, paragraph) => sum + paragraph.length + 1, 0);
    let offset = 0;
    return paragraphs.map((paragraph) => {
      const at = end !== null && end > start && total > 0 ? start + ((end - start) * offset) / total : start;
      offset += paragraph.length + 1;
      return Math.round(at * 10) / 10;
    });
  });
}

/**
 * The paragraph being spoken at `seconds`: the last one to have started.
 * Null before the first one starts (the hold music) or without times.
 */
export function lineAt(
  starts: ReadonlyArray<ReadonlyArray<number | null>>,
  seconds: number,
): TranscriptLine | null {
  let found: TranscriptLine | null = null;
  let foundStart = Number.NEGATIVE_INFINITY;
  // Starts rise through the call, but a turn can repeat the last start of the
  // one before it; the later paragraph wins a tie.
  for (const [turn, paragraphs] of starts.entries()) {
    for (const [paragraph, start] of paragraphs.entries()) {
      if (start === null || start > seconds + 0.05 || start < foundStart) continue;
      found = { turn, paragraph };
      foundStart = start;
    }
  }
  return found;
}

/** One occurrence of a find query: its paragraph and which occurrence in it. */
export interface TranscriptMatch extends TranscriptLine {
  occurrence: number;
}

/** Every occurrence of `query` in `lines`, in reading order, ignoring case. */
export function findInLines(
  lines: ReadonlyArray<TranscriptLine & { text: string }>,
  query: string,
): TranscriptMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: TranscriptMatch[] = [];
  for (const line of lines) {
    const haystack = line.text.toLowerCase();
    let occurrence = 0;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      matches.push({ turn: line.turn, paragraph: line.paragraph, occurrence: occurrence++ });
    }
  }
  return matches;
}
