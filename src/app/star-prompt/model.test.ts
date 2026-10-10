import { describe, expect, test } from "bun:test";
import type { StarPromptConfig } from "../../types/config";
import {
  finishStarPrompt,
  isStarPromptDue,
  localDayKey,
  markStarPromptShown,
  recordStarPromptDay,
  starPromptEnvironmentAllows,
} from "./model";

function openOn(days: string[], start?: StarPromptConfig): StarPromptConfig | undefined {
  return days.reduce<StarPromptConfig | undefined>((state, day) => recordStarPromptDay(state, day), start);
}

describe("star prompt trigger", () => {
  test("comes due on the third distinct day of use, not the third launch", () => {
    const sameDay = openOn(["2026-10-01", "2026-10-01", "2026-10-01"]);
    expect(sameDay).toEqual({ days: ["2026-10-01"] });
    expect(isStarPromptDue(sameDay)).toBe(false);

    const twoDays = openOn(["2026-10-01", "2026-10-03"]);
    expect(isStarPromptDue(twoDays)).toBe(false);

    const threeDays = openOn(["2026-10-01", "2026-10-03", "2026-10-03", "2026-10-09"]);
    expect(threeDays).toEqual({ days: ["2026-10-01", "2026-10-03", "2026-10-09"] });
    expect(isStarPromptDue(threeDays)).toBe(true);
    // Later days change nothing, so a due line does not rewrite the config every launch.
    expect(recordStarPromptDay(threeDays, "2026-10-10")).toBe(threeDays);
  });

  test("keys a day by the local calendar date", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDayKey(new Date(2026, 0, 6, 0, 1))).toBe("2026-01-06");
  });

  test("shows once: after it showed, however it ended, it is never due again", () => {
    const due = openOn(["2026-10-01", "2026-10-02", "2026-10-03"]);
    const shown = markStarPromptShown(due, new Date("2026-10-03T12:00:00.000Z"));
    expect(shown).toEqual({ shownAt: "2026-10-03T12:00:00.000Z" });
    // Quitting while it shows leaves only `shownAt`, which already ends it.
    expect(isStarPromptDue(shown)).toBe(false);
    expect(recordStarPromptDay(shown, "2026-10-04")).toBe(shown);
    for (const outcome of ["opened", "dismissed", "expired"] as const) {
      const ended = finishStarPrompt(shown, outcome);
      expect(ended).toEqual({ shownAt: "2026-10-03T12:00:00.000Z", outcome });
      expect(isStarPromptDue(ended)).toBe(false);
    }
  });

  test("the off switch stops it before and after the days add up", () => {
    const off: StarPromptConfig = { enabled: false };
    expect(openOn(["2026-10-01", "2026-10-02", "2026-10-03"], off)).toBe(off);
    expect(isStarPromptDue(off)).toBe(false);
    expect(isStarPromptDue({ enabled: false, days: ["2026-10-01", "2026-10-02", "2026-10-03"] })).toBe(false);
    expect(isStarPromptDue({ enabled: true, days: ["2026-10-01", "2026-10-02", "2026-10-03"] })).toBe(true);
  });
});

describe("starPromptEnvironmentAllows", () => {
  const terminal = { env: {}, stdinIsTTY: true, stdoutIsTTY: true };

  test("allows someone at an interactive terminal", () => {
    expect(starPromptEnvironmentAllows(terminal)).toBe(true);
    expect(starPromptEnvironmentAllows({ ...terminal, env: { CI: "false" } })).toBe(true);
  });

  test("never allows piped, CI or test runs", () => {
    expect(starPromptEnvironmentAllows({ ...terminal, stdoutIsTTY: false })).toBe(false);
    expect(starPromptEnvironmentAllows({ ...terminal, stdinIsTTY: undefined })).toBe(false);
    expect(starPromptEnvironmentAllows({ ...terminal, env: { CI: "true" } })).toBe(false);
    expect(starPromptEnvironmentAllows({ ...terminal, env: { CI: "1" } })).toBe(false);
    expect(starPromptEnvironmentAllows({ ...terminal, env: { NODE_ENV: "test" } })).toBe(false);
  });
});
