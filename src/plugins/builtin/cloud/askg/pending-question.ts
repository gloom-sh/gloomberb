import type { AskGloomPaneAttachment } from "../../../../ask-gloom/pane-request";
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

/**
 * Hand-off for a pane asked about from its header, its menu or the pane-ask
 * key: the pane opens (or focuses) and starts a new conversation with it.
 * In memory only, for the same reason as a question.
 */
const panes = createPaneRequestChannel<AskGloomPaneAttachment>();

export const requestASKGPaneAttachment = panes.request;
export const subscribeASKGPaneAttachments = panes.subscribe;
