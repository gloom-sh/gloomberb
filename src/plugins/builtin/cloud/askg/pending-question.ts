import { createPaneRequestChannel } from "../../shared/pane-request";

/**
 * Hand-off for a question typed at the command bar. The ASKG shortcut can both
 * open the pane and reuse the one already open, so the question travels here
 * rather than through pane params: a param would be persisted with the layout
 * and replayed on the next launch, and a conversation is not layout.
 */
const questions = createPaneRequestChannel<string>();

export function askGloomQuestion(question: string): void {
  const trimmed = question.trim();
  if (trimmed) questions.request(trimmed);
}

export const subscribeASKGQuestions = questions.subscribe;
