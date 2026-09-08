/**
 * Hand-off for a question typed at the command bar. The ASKG shortcut can both
 * open the pane and reuse the one already open, so the question travels here
 * rather than through pane params: a param would be persisted with the layout
 * and replayed on the next launch, and a conversation is not layout.
 */
type PendingQuestionListener = (question: string) => void;

const listeners = new Set<PendingQuestionListener>();
/** Held only until the pane the shortcut just opened finishes mounting. */
let pendingQuestion: string | null = null;

export function askGloomQuestion(question: string): void {
  const trimmed = question.trim();
  if (!trimmed) return;
  if (listeners.size === 0) {
    pendingQuestion = trimmed;
    return;
  }
  for (const listener of listeners) listener(trimmed);
}

export function subscribeASKGQuestions(listener: PendingQuestionListener): () => void {
  listeners.add(listener);
  const queued = pendingQuestion;
  if (queued !== null) {
    pendingQuestion = null;
    listener(queued);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: drops a question no pane ever claimed. */
export function clearPendingASKGQuestion(): void {
  pendingQuestion = null;
}
