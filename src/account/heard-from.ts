/**
 * "Where did you hear about Gloom?", asked once in the app right after an
 * account signs up (or in) on the first run's account step or in the sign-in
 * dialog. The account is marked due there; the question itself waits until
 * nothing else is on screen: setup has closed (so nothing is added inside the
 * first run) and no dialog is open. A sign-in on its way to a checkout never
 * marks it, so the question is never shown before or over one.
 *
 * The service decides whether the account is asked and settles it for good on
 * the first answer or skip. Every call here fails silently: an error, or a
 * service too old to know the question, just means it is not asked.
 */
import type { HeardFromAnswer, HeardFromState } from "../api-client/heard-from";
import { logFailure } from "../utils/log-failure";

let dueAccount: string | null = null;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** An account just signed up or in here: ask it once nothing else is on screen. */
export function markHeardFromDue(accountId: string): void {
  if (!accountId || dueAccount === accountId) return;
  dueAccount = accountId;
  changed();
}

/** The account the question is due for, if any. */
export function heardFromDueAccount(): string | null {
  return dueAccount;
}

/** Takes the due mark: the question is asked at most once per sign-in. */
export function takeHeardFromDue(accountId: string): boolean {
  if (dueAccount !== accountId) return false;
  dueAccount = null;
  changed();
  return true;
}

export function subscribeHeardFromDue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What the person picked: an answer (with its note, if any), or null for Skip.
 */
export type HeardFromChoice = { answer: HeardFromAnswer; note?: string } | null;

export interface HeardFromQuestionDeps {
  getState(): Promise<HeardFromState>;
  reportShown(): Promise<void>;
  answer(answer: HeardFromAnswer, note?: string): Promise<void>;
  skip(): Promise<void>;
  /**
   * Shows the question and resolves with the choice. `shown` is called once it
   * is on screen; `picked` the moment an answer with a follow-up is picked,
   * so the answer is kept before the note is written.
   */
  ask(shown: () => void, picked: (answer: HeardFromAnswer) => void): Promise<HeardFromChoice>;
}

export type HeardFromOutcome = "not-asked" | "answered" | "skipped";

/**
 * Asks when the service says to, and keeps the answer. Never throws: a
 * failed read, an older service (its 404) or invalid data ask nothing, and a
 * failed write is only logged, as the question has already closed.
 *
 * An answer picked ahead of its note is sent at once. Closing the note then
 * keeps that answer (never a skip); a written note follows with the same
 * answer.
 */
export async function runHeardFromQuestion(deps: HeardFromQuestionDeps): Promise<HeardFromOutcome> {
  let state: HeardFromState;
  try {
    state = await deps.getState();
  } catch (error) {
    logFailure("heard-from", "Reading whether to ask failed")(error);
    return "not-asked";
  }
  if (!state.ask) return "not-asked";
  let reported = false;
  const shown = () => {
    if (reported) return;
    reported = true;
    deps.reportShown().catch(logFailure("heard-from", "Reporting the question shown failed"));
  };
  let kept: HeardFromAnswer | null = null;
  const picked = (answer: HeardFromAnswer) => {
    if (kept) return;
    kept = answer;
    deps.answer(answer).catch(logFailure("heard-from", "Saving the answer failed"));
  };
  let choice: HeardFromChoice;
  try {
    choice = await deps.ask(shown, picked);
  } catch (error) {
    logFailure("heard-from", "Showing the question failed")(error);
    return kept ? "answered" : "not-asked";
  }
  if (kept) {
    if (choice?.answer === kept && choice.note) {
      deps.answer(kept, choice.note).catch(logFailure("heard-from", "Saving the note failed"));
    }
    return "answered";
  }
  if (!choice) {
    deps.skip().catch(logFailure("heard-from", "Saving the skip failed"));
    return "skipped";
  }
  deps.answer(choice.answer, choice.note).catch(logFailure("heard-from", "Saving the answer failed"));
  return "answered";
}
