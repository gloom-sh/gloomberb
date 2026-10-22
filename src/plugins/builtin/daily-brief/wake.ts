import type { PaneTemplateCreateOptions, PaneTemplateInstanceConfig } from "../../../types/plugin";
import { zonedDateKey } from "../../../utils/zoned-date-time";

export const DAILY_BRIEF_PLUGIN_ID = "daily-brief";
export const DAILY_BRIEF_PANE_ID = "daily-brief";
export const DAILY_BRIEF_TEMPLATE_ID = "daily-brief-pane";
export const OPEN_ON_WAKE_SETTING = "openOnWake";
export const OPENED_ON_KEY = "openedOn";

/**
 * A suspended laptop resumes with the clock jumped by the whole sleep.
 * A process that stayed awake ticks across midnight a few seconds at a time
 * and must not pop the brief in the middle of a session.
 */
export const BRIEF_WAKE_GAP_MS = 5 * 60_000;

const armedWakes = new Set<string>();

export function openOnWakeEnabled(value: unknown): boolean {
  return value !== false;
}

export function briefWakeTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** True when this process was started to open a named command, so DAY must not cover it. */
export function launchedWithCommand(argv: readonly string[]): boolean {
  const positional = argv.filter((arg) => arg.length > 0 && !arg.startsWith("-"));
  if (positional.length === 0) return false;
  if (positional.length === 1 && (positional[0] === "ui" || positional[0] === "launch-ui")) return false;
  return true;
}

export interface BriefWakeInput {
  enabled: boolean;
  openedOn: string | null;
  now: number;
  previousTick: number | null;
  timeZone: string;
  kind: "startup" | "tick";
  launchedCommand: boolean;
}

/** Whether this moment should put the brief in front, and the local day it belongs to. */
export function briefWakeDecision(input: BriefWakeInput): { open: boolean; day: string } {
  const day = zonedDateKey(input.now, input.timeZone);
  if (!input.enabled || input.openedOn === day) return { open: false, day };
  if (input.kind === "startup") return { open: !input.launchedCommand, day };
  if (input.previousTick == null || input.now - input.previousTick < BRIEF_WAKE_GAP_MS) return { open: false, day };
  const sleptAcrossMidnight = zonedDateKey(input.previousTick, input.timeZone) !== day;
  return { open: sleptAcrossMidnight, day };
}

export type BriefSyncPhase = "idle" | "disabled" | "syncing" | "synced" | "error";

/**
 * A startup pull replaces the open layout. Wait until that pull has landed,
 * or until it is clear the account has no sync to run.
 */
export function initialSyncSettled(input: { phase: BriefSyncPhase; elapsedMs: number; sawSyncing: boolean }): boolean {
  if (input.phase === "synced" || input.phase === "error") return true;
  if (input.sawSyncing && input.phase !== "syncing") return true;
  if (input.phase === "disabled" && input.elapsedMs >= 500) return true;
  return input.elapsedMs >= 30_000;
}

/** On wake, a foreground pull may still be about to start. Let it finish before focusing. */
export function wakeSyncSettled(input: { phase: BriefSyncPhase; elapsedMs: number; sawSyncing: boolean }): boolean {
  if (input.sawSyncing && input.phase !== "syncing") return true;
  if (!input.sawSyncing && input.elapsedMs >= 1_000) return true;
  return input.elapsedMs >= 8_000;
}

export function armDailyBriefWake(token: string): void {
  armedWakes.add(token);
}

export function acceptDailyBriefWake(token: string | undefined): void {
  if (token) armedWakes.delete(token);
}

export function dailyBriefWakePending(token: string): boolean {
  return armedWakes.has(token);
}

export function createDailyBriefInstance(options?: PaneTemplateCreateOptions): PaneTemplateInstanceConfig {
  acceptDailyBriefWake(options?.values?.wake);
  return { placement: "floating" };
}
