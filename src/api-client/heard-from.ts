import type { CloudApiRequest } from "./request";

/**
 * "Where did you hear about Gloom?": one optional question a new account is
 * asked once, kept on the account. The service decides whether to ask and
 * settles it for good on the first answer or skip; the account comes from
 * the session alone. The app asks before the email is confirmed
 * (`unconfirmed=1`), since confirming holds nothing up here.
 */
export const HEARD_FROM_ANSWERS = [
  "search",
  "youtube",
  "tiktok",
  "instagram",
  "x",
  "reddit",
  "ai_assistant",
  "friend",
  "article",
  "other",
] as const;

export type HeardFromAnswer = (typeof HEARD_FROM_ANSWERS)[number];

/**
 * Answers with an optional follow-up. The answer is kept the moment it is picked;
 * the note is sent after it, with the same answer, if written.
 */
const HEARD_FROM_NOTE_ANSWERS: ReadonlySet<HeardFromAnswer> = new Set(["youtube", "tiktok", "instagram", "x", "ai_assistant"]);

export function heardFromAsksForNote(answer: HeardFromAnswer): boolean {
  return HEARD_FROM_NOTE_ANSWERS.has(answer);
}

/** The longest note the service keeps, in characters. */
export const HEARD_FROM_NOTE_MAX_LENGTH = 120;

export interface HeardFromState {
  /** Show the question now. */
  ask: boolean;
  /** The answer is final: it will never be asked again. */
  settled: boolean;
}

function parseHeardFromState(value: unknown): HeardFromState {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  if (!record || typeof record.ask !== "boolean" || typeof record.settled !== "boolean") {
    throw new Error("The account service returned invalid data.");
  }
  return { ask: record.ask, settled: record.settled };
}

/** One line, trimmed, cut to what the service keeps (counted in characters, not UTF-16 units). */
function heardFromNote(text: string): string {
  return [...text.replace(/\s+/g, " ").trim()].slice(0, HEARD_FROM_NOTE_MAX_LENGTH).join("").trim();
}

export class CloudHeardFromApi {
  constructor(private readonly request: CloudApiRequest) {}

  async getHeardFrom(signal?: AbortSignal): Promise<HeardFromState> {
    return parseHeardFromState(await this.request<unknown>("/account/heard-from?unconfirmed=1", { signal }));
  }

  /** The question is on screen. */
  async reportHeardFromShown(): Promise<void> {
    await this.request<unknown>("/account/heard-from/shown?unconfirmed=1", { method: "POST" });
  }

  /**
   * An answer, with Other's text or an optional follow-up. A repeat or a later
   * answer changes nothing; the same answer again with its note adds it (a service without notes
   * refuses it, and the answer stays).
   */
  async answerHeardFrom(answer: HeardFromAnswer, note?: string): Promise<void> {
    const text = note && (answer === "other" || heardFromAsksForNote(answer)) ? heardFromNote(note) : "";
    const body = !text ? { answer } : answer === "other" ? { answer, other: text } : { answer, note: text };
    await this.request<unknown>("/account/heard-from", { method: "POST", body: JSON.stringify(body) });
  }

  async skipHeardFrom(): Promise<void> {
    await this.request<unknown>("/account/heard-from", { method: "POST", body: JSON.stringify({ skip: true }) });
  }
}
