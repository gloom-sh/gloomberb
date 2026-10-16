import { describe, expect, test } from "bun:test";
import { zonedDateKey } from "../../../utils/zoned-date-time";
import {
  armDailyBriefWake,
  briefWakeDecision,
  BRIEF_WAKE_GAP_MS,
  createDailyBriefInstance,
  dailyBriefWakePending,
  initialSyncSettled,
  launchedWithCommand,
  openOnWakeEnabled,
  wakeSyncSettled,
} from "./wake";

const ZONE = "America/New_York";

function at(iso: string): number {
  return Date.parse(iso);
}

describe("open on wake", () => {
  test("the switch defaults on and only an explicit off disables it", () => {
    expect(openOnWakeEnabled(undefined)).toBe(true);
    expect(openOnWakeEnabled(null)).toBe(true);
    expect(openOnWakeEnabled(true)).toBe(true);
    expect(openOnWakeEnabled(false)).toBe(false);
  });

  test("a plain launch opens once for the local day", () => {
    const now = at("2026-10-05T14:00:00Z");
    const day = zonedDateKey(now, ZONE);
    const base = {
      enabled: true,
      openedOn: null,
      now,
      previousTick: null,
      timeZone: ZONE,
      kind: "startup" as const,
      launchedCommand: false,
    };
    expect(briefWakeDecision(base)).toEqual({ open: true, day });
    expect(briefWakeDecision({ ...base, openedOn: day }).open).toBe(false);
    expect(briefWakeDecision({ ...base, openedOn: "2026-10-04" }).open).toBe(true);
    expect(briefWakeDecision({ ...base, enabled: false }).open).toBe(false);
    expect(briefWakeDecision({ ...base, launchedCommand: true }).open).toBe(false);
  });

  test("a clock jump across midnight opens, and a live tick or a same-day sleep does not", () => {
    const morning = at("2026-10-05T11:00:00Z");
    const day = zonedDateKey(morning, ZONE);
    const overnight = at("2026-10-05T03:00:00Z");
    expect(morning - overnight).toBeGreaterThan(BRIEF_WAKE_GAP_MS);
    expect(zonedDateKey(overnight, ZONE)).not.toBe(day);
    const tick = {
      enabled: true,
      openedOn: zonedDateKey(overnight, ZONE),
      now: morning,
      previousTick: overnight,
      timeZone: ZONE,
      kind: "tick" as const,
      launchedCommand: false,
    };
    expect(briefWakeDecision(tick)).toEqual({ open: true, day });

    const doze = at("2026-10-05T20:00:00Z");
    const afternoon = at("2026-10-05T14:00:00Z");
    expect(briefWakeDecision({
      ...tick,
      openedOn: null,
      now: doze,
      previousTick: afternoon,
    }).open).toBe(false);

    const beforeMidnight = at("2026-10-06T03:59:50Z");
    const afterMidnight = beforeMidnight + 15_000;
    expect(zonedDateKey(beforeMidnight, ZONE)).not.toBe(zonedDateKey(afterMidnight, ZONE));
    expect(briefWakeDecision({
      ...tick,
      openedOn: zonedDateKey(beforeMidnight, ZONE),
      now: afterMidnight,
      previousTick: beforeMidnight,
    }).open).toBe(false);
    expect(briefWakeDecision({ ...tick, previousTick: null }).open).toBe(false);
  });

  test("startup waits out a pull, and a wake waits only long enough for one to begin", () => {
    expect(initialSyncSettled({ phase: "syncing", elapsedMs: 10_000, sawSyncing: true })).toBe(false);
    expect(initialSyncSettled({ phase: "synced", elapsedMs: 0, sawSyncing: false })).toBe(true);
    expect(initialSyncSettled({ phase: "error", elapsedMs: 0, sawSyncing: false })).toBe(true);
    expect(initialSyncSettled({ phase: "disabled", elapsedMs: 100, sawSyncing: false })).toBe(false);
    expect(initialSyncSettled({ phase: "disabled", elapsedMs: 500, sawSyncing: false })).toBe(true);
    expect(initialSyncSettled({ phase: "idle", elapsedMs: 5_000, sawSyncing: false })).toBe(false);
    expect(initialSyncSettled({ phase: "idle", elapsedMs: 30_000, sawSyncing: false })).toBe(true);
    expect(wakeSyncSettled({ phase: "idle", elapsedMs: 100, sawSyncing: false })).toBe(false);
    expect(wakeSyncSettled({ phase: "synced", elapsedMs: 1_000, sawSyncing: false })).toBe(true);
    expect(wakeSyncSettled({ phase: "syncing", elapsedMs: 5_000, sawSyncing: true })).toBe(false);
    expect(wakeSyncSettled({ phase: "idle", elapsedMs: 1_200, sawSyncing: true })).toBe(true);
  });

  test("a named command is the thing that was launched", () => {
    expect(launchedWithCommand([])).toBe(false);
    expect(launchedWithCommand(["ui"])).toBe(false);
    expect(launchedWithCommand(["launch-ui"])).toBe(false);
    expect(launchedWithCommand(["--watch"])).toBe(false);
    expect(launchedWithCommand(["ERN"])).toBe(true);
  });

  test("the wake token is consumed without changing the floating pane", () => {
    armDailyBriefWake("day-1");
    expect(dailyBriefWakePending("day-1")).toBe(true);
    expect(createDailyBriefInstance({ values: { wake: "day-1" } })).toEqual({ placement: "floating" });
    expect(dailyBriefWakePending("day-1")).toBe(false);
    expect(createDailyBriefInstance()).toEqual({ placement: "floating" });
  });
});
