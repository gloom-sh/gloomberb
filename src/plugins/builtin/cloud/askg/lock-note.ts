import type { PaneLock } from "../../../../types/plugin";

/**
 * What `fn ASKG` prints behind the sign-in wall, where commands are at hand:
 * what unlocks Ask Gloom and how, the plugin that runs AI on the reader's own
 * provider key instead (`AI` and `AGENT`), and the command that finds an
 * answer without AI. The pane's own wall says only the first part.
 */
export function askgLockNote({ verifyEmail }: PaneLock): string {
  const account = verifyEmail
    ? "verify your email in the app (Ctrl+P, Resend Verification Email)"
    : "log in or sign up free in the app (Ctrl+P, Log In or Sign Up)";
  return [
    `Ask Gloom (ASKG in the app) needs only a free, verified Gloom account: ${account}.`,
    "With your own AI provider key instead: `gloom install gloom-sh/gloom-byok-ai` adds the BYOK AI plugin (AI screener, AGENT, `gloom ai`).",
    "Without AI: `gloom catalog <topic>` finds the function for a question, e.g. `gloom catalog dividends`.",
  ].join("\n");
}
