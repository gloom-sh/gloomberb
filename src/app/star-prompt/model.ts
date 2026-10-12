import type { StarPromptConfig } from "../../types/config";
import { isRecord } from "../../utils/guards";

/**
 * The one-time line in the terminal's status bar asking to star the
 * repository. It waits for the third distinct day the terminal app is opened
 * on, then for a minute on screen that day, shows once, and never again:
 * opening the repository, dismissing it and its timeout all end it, and so
 * does quitting while it shows. `starPrompt.enabled: false` turns it off.
 */

export const STAR_PROMPT_REPO_URL = "https://github.com/gloom-sh/gloomberb";
/** The line waits for this many distinct days of use, today included. */
const STAR_PROMPT_SESSION_DAYS = 3;
/** On-screen time on the due day before the line shows. */
export const STAR_PROMPT_DELAY_MS = 60_000;
/** On-screen time the line stays before it times out. */
export const STAR_PROMPT_VISIBLE_MS = 5 * 60_000;

type StarPromptOutcome = NonNullable<StarPromptConfig["outcome"]>;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OUTCOMES = new Set<StarPromptOutcome>(["opened", "dismissed", "expired"]);

/** The local calendar day of `date`, as `YYYY-MM-DD`. */
export function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function isOff(state: StarPromptConfig | undefined): boolean {
  return state?.enabled === false || !!state?.shownAt;
}

/**
 * Adds `day` to the days of use. Returns the same object when nothing changes:
 * the line is off or already shown, the day is known, or enough days are.
 */
export function recordStarPromptDay(state: StarPromptConfig | undefined, day: string): StarPromptConfig | undefined {
  if (isOff(state)) return state;
  const days = state?.days ?? [];
  if (days.includes(day) || days.length >= STAR_PROMPT_SESSION_DAYS) return state;
  return { ...state, days: [...days, day] };
}

/** Whether the line is waiting to show: on, never shown, and used on enough days. */
export function isStarPromptDue(state: StarPromptConfig | undefined): boolean {
  return !isOff(state) && (state?.days?.length ?? 0) >= STAR_PROMPT_SESSION_DAYS;
}

/** Records that the line showed. The days are no longer needed once it has. */
export function markStarPromptShown(state: StarPromptConfig | undefined, at: Date): StarPromptConfig {
  const { days: _days, ...rest } = state ?? {};
  return { ...rest, shownAt: at.toISOString() };
}

export function finishStarPrompt(state: StarPromptConfig | undefined, outcome: StarPromptOutcome): StarPromptConfig {
  return { ...state, outcome };
}

/** Only the fields that hold a valid value survive; an empty object is the same as none. */
export function sanitizeStarPrompt(value: unknown): StarPromptConfig | undefined {
  if (!isRecord(value)) return undefined;
  const days = Array.isArray(value.days)
    ? [...new Set(value.days.filter((day): day is string => typeof day === "string" && DAY_PATTERN.test(day)))]
      .slice(0, STAR_PROMPT_SESSION_DAYS)
    : [];
  const state: StarPromptConfig = {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(days.length > 0 ? { days } : {}),
    ...(typeof value.shownAt === "string" && value.shownAt ? { shownAt: value.shownAt } : {}),
    ...(typeof value.outcome === "string" && OUTCOMES.has(value.outcome as StarPromptOutcome)
      ? { outcome: value.outcome as StarPromptOutcome }
      : {}),
  };
  return Object.keys(state).length > 0 ? state : undefined;
}

function isSet(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && normalized !== "0" && normalized !== "false";
}

/**
 * Whether this process is someone sitting at the terminal: both ends of the
 * terminal are a TTY, and it is neither a CI job nor a test run. Bots, CI,
 * scripts and smoke runs that pipe the app never see the line.
 */
export function starPromptEnvironmentAllows(input: {
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean | undefined;
  stdoutIsTTY: boolean | undefined;
}): boolean {
  if (input.stdinIsTTY !== true || input.stdoutIsTTY !== true) return false;
  if (isSet(input.env.CI)) return false;
  return input.env.NODE_ENV !== "test";
}
