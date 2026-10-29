import { describe, expect, test } from "bun:test";
import { getThemeColors } from "../../../theme/colors";
import { DEFAULT_THEME, getThemeIds } from "../../../theme/themes";
import type { SponsorTicker } from "./sponsor-tickers";
import {
  hasTrialPhase,
  normalizeTrialFilters,
  orderTrials,
  trialLayout,
  trialPhaseLabel,
  trialPhaseRank,
  trialStatus,
  trialStatusColor,
  trialStatusText,
} from "./model";

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

test("a phase the table can show is told from one it blanks, and the later phase ranks first", () => {
  expect([["PHASE3"], ["PHASE2", "PHASE3"], ["EARLY_PHASE1"]].map(hasTrialPhase)).toEqual([true, true, true]);
  // Not applicable (a device study) and no phase (observational) are both blank in the table.
  expect([[], ["NA"]].map(hasTrialPhase)).toEqual([false, false]);
  expect([["PHASE4"], ["PHASE3"], ["PHASE2", "PHASE3"], ["PHASE2"], ["PHASE1"], ["EARLY_PHASE1"], ["NA"], []].map(trialPhaseRank))
    .toEqual([4, 3, 3, 2, 1, 0.5, 0, 0]);
});

describe("trial order", () => {
  const listed = (ticker: string): SponsorTicker => ({ kind: "listed", ticker, exchange: "NYSE", entityName: null });
  const trial = (nctId: string, sponsor: string, sponsorClass: string, phases: string[] = []) => ({ nctId, sponsor, sponsorClass, phases });
  const tickers: Record<string, SponsorTicker> = {
    AbbVie: listed("ABBV"),
    Bayer: listed("BAYN"),
    "Biomea Fusion": { kind: "pending" },
    "Acme Biotech": { kind: "none", entityName: null, ambiguous: false },
  };
  const order = (trials: ReturnType<typeof trial>[]) => orderTrials(trials, (entry) => tickers[entry.sponsor]).map((entry) => entry.nctId);

  test("listed sponsors first, then other companies (one still being looked up reads as one), then everything else, the latest phase first in each", () => {
    expect(order([
      trial("uni-3", "University of Oxford", "OTHER", ["PHASE3"]),
      trial("acme-4", "Acme Biotech", "INDUSTRY", ["PHASE4"]),
      trial("nih-2", "NIH Institute", "NIH", ["PHASE2"]),
      trial("abbv-1", "AbbVie", "INDUSTRY", ["PHASE1"]),
      trial("bayer-3", "Bayer", "INDUSTRY", ["PHASE3"]),
      trial("abbv-none", "AbbVie", "INDUSTRY"),
      trial("biomea-2", "Biomea Fusion", "INDUSTRY", ["PHASE2"]),
    ])).toEqual(["bayer-3", "abbv-1", "abbv-none", "acme-4", "biomea-2", "uni-3", "nih-2"]);
  });

  test("studies of one group and phase keep the registry's order, and the loaded rows are not touched", () => {
    const rows = [
      trial("a", "AbbVie", "INDUSTRY", ["PHASE2"]),
      trial("b", "Bayer", "INDUSTRY", ["PHASE2"]),
      trial("c", "AbbVie", "INDUSTRY", ["PHASE3"]),
    ];
    expect(order(rows)).toEqual(["c", "a", "b"]);
    expect(rows.map((entry) => entry.nctId)).toEqual(["a", "b", "c"]);
  });
});

test("the title keeps its room at every width: the date gives way first, then the drug, and the columns fill the pane", () => {
  const ids = (width: number) => trialLayout(width).columns.map((column) => column.id);
  for (const width of [66, 78, 90, 100, 120, 158]) {
    const { columns } = trialLayout(width);
    // Each column, the gap after it, and the table's padding.
    expect(columns.reduce((sum, column) => sum + column.width + 1, 0) + 2).toBeLessThanOrEqual(width);
    // The title reads before the date, which is the last column.
    expect(ids(width).indexOf("title")).toBeLessThan(ids(width).indexOf("updated") === -1 ? Infinity : ids(width).indexOf("updated"));
  }
  expect(ids(158)).toEqual(["phase", "status", "title", "drug", "sponsor", "ticker", "updated"]);
  // 720 px is 90 cells: the drug is there, the date is not, and the title has more than it had with the date.
  expect(ids(90)).toEqual(["phase", "status", "title", "drug", "sponsor", "ticker"]);
  expect(trialLayout(90).columns.find((column) => column.id === "title")!.width).toBeGreaterThanOrEqual(28);
  expect(ids(120)).toContain("updated");
  // Narrower still, the drug goes too, and the title keeps 18 cells or more.
  expect(ids(78)).toEqual(["phase", "status", "title", "sponsor", "ticker"]);
  expect(trialLayout(66).columns.find((column) => column.id === "title")!.width).toBeGreaterThanOrEqual(18);
  expect(trialLayout(158).columns.find((column) => column.id === "status")!.width).toBeGreaterThanOrEqual("Enrolling by invitation".length);
  // With the date in, the title is never narrower than 36 cells.
  for (const width of [120, 130, 158, 200]) expect(trialLayout(width).columns.find((column) => column.id === "title")!.width).toBeGreaterThanOrEqual(36);
});
