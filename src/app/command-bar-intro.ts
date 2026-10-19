import type { AppConfig } from "../types/config";

/**
 * The empty command bar's introduction: the Start Here rows in plain words and
 * a placeholder with plain words to type. It shows for the first opens of the
 * empty bar on this machine and then never again, so the bar settles into the
 * list someone who knows the codes expects.
 */
const COMMAND_BAR_INTRO_OPENS = 10;

/**
 * Where the count stops: one past the last open with the introduction. It
 * changes no more after that, so it is never saved again.
 */
const COMMAND_BAR_OPENS_DONE = COMMAND_BAR_INTRO_OPENS + 1;

/**
 * The saved count, or done when there is none. A new config starts at 0, so a
 * config without one was made by a build from before the count, by someone who
 * has been opening the bar all along.
 */
export function sanitizeCommandBarOpens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return COMMAND_BAR_OPENS_DONE;
  return Math.min(COMMAND_BAR_OPENS_DONE, Math.max(0, Math.floor(value)));
}

/** The count after the empty bar opens once more. */
export function recordCommandBarOpen(opens: number | undefined): number {
  return Math.min(COMMAND_BAR_OPENS_DONE, sanitizeCommandBarOpens(opens) + 1);
}

/**
 * Whether the open bar is one of the first opens. The count already includes
 * this open, so it reads the same for as long as the bar stays open.
 */
export function showsCommandBarIntro(config: Pick<AppConfig, "commandBarOpens">): boolean {
  return sanitizeCommandBarOpens(config.commandBarOpens) <= COMMAND_BAR_INTRO_OPENS;
}
