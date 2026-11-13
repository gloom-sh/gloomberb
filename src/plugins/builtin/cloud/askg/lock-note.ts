import type { PaneLock } from "../../../../types/plugin";
import { logFailure } from "../../../../utils/log-failure";

/** The most functions the note offers for a question. */
export const ASKG_QUESTION_FUNCTIONS = 3;

/**
 * What `fn ASKG` prints behind the sign-in wall, where commands are at hand:
 * what unlocks Ask Gloom and how, the plugin that runs AI on the reader's own
 * provider key instead (`AI` and `AGENT`), and what answers without AI: the
 * functions the catalog finds for the question asked ("what did the DAX do
 * yesterday" finds WEI and CMP), else the command that finds them. The
 * pane's own wall says only the first part, and the functions.
 */
export async function askgLockNote({ verifyEmail, argument, functionsFor }: PaneLock): Promise<string> {
  const account = verifyEmail
    ? "verify your email in the app (Ctrl+P, Resend Verification Email)"
    : "log in or sign up free in the app (Ctrl+P, Log In or Sign Up)";
  const question = argument?.trim() ?? "";
  const found = question && functionsFor
    ? await functionsFor(question, ASKG_QUESTION_FUNCTIONS).catch(logFailure("askg.lock-note", "Find the functions for a question failed", []))
    : [];
  return [
    `Ask Gloom (ASKG in the app) needs only a free, verified Gloom account: ${account}.`,
    "With your own AI provider key instead: `gloom install gloom-sh/gloom-byok-ai` adds the BYOK AI plugin (AI screener, AGENT, `gloom ai`).",
    ...found.length > 0
      ? ["Without AI, the catalog finds these functions for the question:", ...found.map((entry) => `${entry.command}  ${entry.label}`)]
      : ["Without AI: `gloom catalog <topic>` finds the function for a question, e.g. `gloom catalog dividends`."],
  ].join("\n");
}
