import { describe, expect, test } from "bun:test";
import { getThemeColors } from "../../../theme/colors";
import { DEFAULT_THEME, getThemeIds } from "../../../theme/themes";
import { normalizeTrialFilters, trialLayout, trialPhaseLabel, trialStatus, trialStatusColor, trialStatusText } from "./model";

describe("trial status", () => {
  test("reads in the registry's words with a tone per stage, and a new code still reads as words", () => {
    expect(["RECRUITING", "NOT_YET_RECRUITING", "ACTIVE_NOT_RECRUITING", "ENROLLING_BY_INVITATION", "COMPLETED", "SUSPENDED", "TERMINATED", "WITHDRAWN", "UNKNOWN"]
      .map((code) => [trialStatus(code).label, trialStatus(code).tone])).toEqual([
      ["Recruiting", "recruiting"],
      ["Not yet recruiting", "upcoming"],
      ["Active, not recruiting", "running"],
      ["Enrolling by invitation", "running"],
      ["Completed", "done"],
      ["Suspended", "paused"],
      ["Terminated", "stopped"],
      ["Withdrawn", "stopped"],
      ["Unknown status", "unknown"],
    ]);
    expect(trialStatus("ON_CLINICAL_HOLD")).toEqual({ label: "On clinical hold", short: "On clinical hold", tone: "unknown" });
  });

  test("a narrow status column gets a short word per status that fits and tells the statuses apart; a wide one the registry's words", () => {
    const codes = ["NOT_YET_RECRUITING", "RECRUITING", "ENROLLING_BY_INVITATION", "ACTIVE_NOT_RECRUITING", "COMPLETED", "SUSPENDED", "TERMINATED", "WITHDRAWN", "UNKNOWN",
      "AVAILABLE", "TEMPORARILY_NOT_AVAILABLE", "NO_LONGER_AVAILABLE", "APPROVED_FOR_MARKETING", "WITHHELD"];
    for (const width of [66, 78, 98, 138]) {
      const column = trialLayout(width).columns.find((entry) => entry.id === "status")!;
      const texts = codes.map((code) => trialStatusText(trialStatus(code), column.width));
      for (const text of texts) expect(text.length).toBeLessThanOrEqual(column.width);
      expect(new Set(texts).size).toBe(codes.length);
    }
    const narrow = (code: string) => trialStatusText(trialStatus(code), trialLayout(78).columns.find((entry) => entry.id === "status")!.width);
    expect(["NOT_YET_RECRUITING", "RECRUITING", "ENROLLING_BY_INVITATION", "ACTIVE_NOT_RECRUITING", "UNKNOWN"].map(narrow))
      .toEqual(["Upcoming", "Recruiting", "By invite", "Active", "Unknown"]);
    const wide = trialLayout(158).columns.find((entry) => entry.id === "status")!.width;
    expect(codes.slice(0, 9).map((code) => trialStatusText(trialStatus(code), wide))).toEqual(codes.slice(0, 9).map((code) => trialStatus(code).label));
  });

  test("takes every colour from the theme, and the stages a reader acts on stay apart in each theme", () => {
    for (const id of getThemeIds()) {
      const colors = getThemeColors(id);
      const tone = (code: string) => trialStatusColor(trialStatus(code).tone, colors);
      expect(tone("RECRUITING")).toBe(colors.positive);
      expect(tone("TERMINATED")).toBe(colors.negative);
      expect(tone("SUSPENDED")).toBe(colors.warning);
      expect(tone("NOT_YET_RECRUITING")).not.toBe(tone("RECRUITING"));
      expect(tone("COMPLETED")).not.toBe(tone("RECRUITING"));
    }
    const colors = getThemeColors(DEFAULT_THEME);
    const defaults = new Set(["RECRUITING", "NOT_YET_RECRUITING", "ACTIVE_NOT_RECRUITING", "COMPLETED", "SUSPENDED", "TERMINATED", "UNKNOWN"]
      .map((code) => trialStatusColor(trialStatus(code).tone, colors)));
    expect(defaults.size).toBe(7);
  });
});

test("phases read as one label, a study with none as a dash", () => {
  expect(trialPhaseLabel(["PHASE2", "PHASE3"])).toBe("Phase 2/3");
  expect(trialPhaseLabel(["PHASE3", "PHASE2"], true)).toBe("Ph 2/3");
  expect(trialPhaseLabel(["EARLY_PHASE1"])).toBe("Early phase 1");
  expect(trialPhaseLabel(["NA"])).toBe("N/A");
  expect(trialPhaseLabel([])).toBe("--");
});

test("filters keep only the registry's codes, whatever a saved layout or a share carries", () => {
  expect(normalizeTrialFilters({ status: "recruiting", phase: "PHASE3", sponsorClass: "industry" }))
    .toEqual({ status: "RECRUITING", phase: "PHASE3", sponsorClass: "INDUSTRY" });
  expect(normalizeTrialFilters({ status: "OPEN", phase: 3, sponsorClass: null })).toEqual({ status: "all", phase: "all", sponsorClass: "all" });
  expect(normalizeTrialFilters(undefined)).toEqual({ status: "all", phase: "all", sponsorClass: "all" });
});

test("the columns fill the pane at 80 and 160 cells without scrolling sideways", () => {
  for (const width of [78, 98, 158]) {
    const { columns } = trialLayout(width);
    // Each column, the gap after it, and the table's padding.
    expect(columns.reduce((sum, column) => sum + column.width + 1, 0) + 2).toBeLessThanOrEqual(width);
    expect(columns.map((column) => column.id)).toEqual(["time", "phase", "status", "title", "sponsor", "ticker"]);
  }
  expect(trialLayout(78).columns.find((column) => column.id === "title")!.width).toBeGreaterThanOrEqual(20);
  // Narrower still, the posting age gives way before the title does.
  expect(trialLayout(66).columns.map((column) => column.id)).toEqual(["phase", "status", "title", "sponsor", "ticker"]);
  expect(trialLayout(66).columns.find((column) => column.id === "title")!.width).toBeGreaterThanOrEqual(18);
  expect(trialLayout(158).columns.find((column) => column.id === "status")!.width).toBeGreaterThanOrEqual("Enrolling by invitation".length);
});
