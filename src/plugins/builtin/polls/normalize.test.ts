import { describe, expect, test } from "bun:test";
import { parseVoteHubPollsPayload } from "./client";
import {
  computeMarginOfError,
  computeMovingAverage,
  computePollAverages,
  computePollsterAverages,
  computePollTrend,
  filterPollRows,
  normalizeVoteHubPoll,
  parseSampleSize,
  populationLabel,
  sortPollRows,
  summarizeAnswers,
} from "./normalize";
import type { PollRow, VoteHubPoll } from "./types";

function makePoll(overrides: Partial<VoteHubPoll> = {}): VoteHubPoll {
  return {
    id: "p1",
    poll_type: "approval",
    sample_size: 1000,
    population: "rv",
    url: null,
    created_at: null,
    start_date: "2026-01-01",
    end_date: "2026-01-03",
    pollster: "Test Pollster",
    answers: [
      { choice: "Approve", pct: 45 },
      { choice: "Disapprove", pct: 50 },
    ],
    seat_name: null,
    sponsors: [],
    internal: false,
    partisan: null,
    subject: "Donald Trump",
    ...overrides,
  };
}

describe("VoteHub normalize", () => {
  test("accepts a bare poll array or a { polls } envelope", () => {
    const poll = makePoll();
    expect(parseVoteHubPollsPayload([poll])).toHaveLength(1);
    expect(parseVoteHubPollsPayload({ polls: [poll] })).toHaveLength(1);
    expect(parseVoteHubPollsPayload({ data: [poll] })).toHaveLength(0);
  });

  test("summarizes a two-way result and lead", () => {
    const summary = summarizeAnswers([
      { choice: "Disapprove", pct: 51 },
      { choice: "Approve", pct: 44 },
    ]);
    expect(summary.leadChoice).toBe("Disapprove");
    expect(summary.lead).toBeCloseTo(7);
    expect(summary.result).toContain("Disapprove");
    expect(summary.result).toContain("Approve");
  });

  test("maps wire fields onto list rows including margin of error", () => {
    const row = normalizeVoteHubPoll(makePoll({
      poll_type: "generic-ballot",
      sample_size: "1,500",
      population: "lv",
      answers: [
        { choice: "Dem", pct: 44.4 },
        { choice: "Rep", pct: 48.4 },
      ],
    }));
    expect(row.pollTypeLabel).toBe("Generic");
    expect(row.population).toBe("Likely");
    expect(row.sampleSize).toBe(1500);
    expect(row.leadChoice).toBe("Rep");
    expect(row.lead).toBeCloseTo(4);
    expect(row.marginOfError).not.toBeNull();
    expect(parseSampleSize("800")).toBe(800);
    expect(populationLabel("rv")).toBe("Reg");
  });

  test("sorts poll rows by date, pollster, or lead", () => {
    const older = normalizeVoteHubPoll(makePoll({
      id: "old",
      start_date: "2026-07-01",
      end_date: "2026-07-02",
      pollster: "YouGov",
      answers: [{ choice: "Approve", pct: 40 }, { choice: "Disapprove", pct: 50 }],
    }));
    const newer = normalizeVoteHubPoll(makePoll({
      id: "new",
      start_date: "2026-08-01",
      end_date: "2026-08-10",
      pollster: "Emerson",
      answers: [{ choice: "Approve", pct: 55 }, { choice: "Disapprove", pct: 40 }],
    }));

    expect(sortPollRows([older, newer]).map((row) => row.id)).toEqual(["new", "old"]);
    expect(sortPollRows([older, newer], { columnId: "pollster", direction: "asc" }).map((row) => row.id))
      .toEqual(["new", "old"]);
    expect(sortPollRows([older, newer], { columnId: "result", direction: "desc" }).map((row) => row.id))
      .toEqual(["new", "old"]);
  });
});

describe("computeMarginOfError", () => {
  test("returns null for missing or invalid sample sizes", () => {
    expect(computeMarginOfError(null)).toBeNull();
    expect(computeMarginOfError(0)).toBeNull();
    expect(computeMarginOfError(-5)).toBeNull();
  });

  test("computes MoE decreasing with larger samples", () => {
    const small = computeMarginOfError(100);
    const large = computeMarginOfError(10_000);
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(small!).toBeGreaterThan(large!);
    // 0.98 / sqrt(1000) ≈ 3.1
    expect(computeMarginOfError(1000)).toBeCloseTo(3.1, 0);
  });
});

describe("filterPollRows", () => {
  const rows = [
    normalizeVoteHubPoll(makePoll({ id: "a", subject: "Donald Trump", pollster: "Ipsos" })),
    normalizeVoteHubPoll(makePoll({ id: "b", subject: "Congress", pollster: "Gallup" })),
    normalizeVoteHubPoll(makePoll({ id: "c", subject: "Donald Trump", pollster: "Emerson" })),
  ];

  test("returns all rows for empty query", () => {
    expect(filterPollRows(rows, "")).toHaveLength(3);
    expect(filterPollRows(rows, "   ")).toHaveLength(3);
  });

  test("filters by subject case-insensitively", () => {
    expect(filterPollRows(rows, "trump").map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("filters by pollster case-insensitively", () => {
    expect(filterPollRows(rows, "gallup").map((r) => r.id)).toEqual(["b"]);
  });
});

describe("computePollTrend", () => {
  const rows = [
    normalizeVoteHubPoll(makePoll({ id: "t1", end_date: "2026-01-10", subject: "Donald Trump", answers: [{ choice: "Approve", pct: 45 }, { choice: "Disapprove", pct: 50 }] })),
    normalizeVoteHubPoll(makePoll({ id: "t2", end_date: "2026-02-10", subject: "Donald Trump", answers: [{ choice: "Approve", pct: 42 }, { choice: "Disapprove", pct: 53 }] })),
    normalizeVoteHubPoll(makePoll({ id: "t3", end_date: "2026-03-10", subject: "Congress", answers: [{ choice: "Approve", pct: 20 }, { choice: "Disapprove", pct: 70 }] })),
  ];

  test("collects sorted time series for matching subject and choice", () => {
    const trend = computePollTrend(rows, "Donald Trump", "Approve");
    expect(trend).toHaveLength(2);
    expect(trend[0]!.date).toBe("2026-01-10");
    expect(trend[1]!.date).toBe("2026-02-10");
    expect(trend[0]!.value).toBe(45);
  });

  test("returns empty for non-matching subject", () => {
    expect(computePollTrend(rows, "Unknown", "Approve")).toHaveLength(0);
  });
});

describe("computeMovingAverage", () => {
  const points = [
    { date: "2026-01-01", value: 40, pollster: "A" },
    { date: "2026-01-02", value: 50, pollster: "B" },
    { date: "2026-01-03", value: 60, pollster: "C" },
    { date: "2026-01-04", value: 30, pollster: "D" },
  ];

  test("computes rolling mean with the given window", () => {
    const ma = computeMovingAverage(points, 2);
    expect(ma).toHaveLength(3);
    expect(ma[0]!.value).toBe(45); // (40+50)/2
    expect(ma[1]!.value).toBe(55); // (50+60)/2
    expect(ma[2]!.value).toBe(45); // (60+30)/2
  });

  test("returns empty when fewer points than window", () => {
    expect(computeMovingAverage(points, 5)).toHaveLength(0);
  });
});

describe("computePollsterAverages", () => {
  const rows: PollRow[] = [
    normalizeVoteHubPoll(makePoll({ id: "pa1", pollster: "Ipsos", sample_size: 1000, subject: "Donald Trump", answers: [{ choice: "Approve", pct: 45 }, { choice: "Disapprove", pct: 50 }] })),
    normalizeVoteHubPoll(makePoll({ id: "pa2", pollster: "Ipsos", sample_size: 2000, subject: "Donald Trump", answers: [{ choice: "Approve", pct: 48 }, { choice: "Disapprove", pct: 47 }] })),
    normalizeVoteHubPoll(makePoll({ id: "pa3", pollster: "Gallup", sample_size: 1000, subject: "Donald Trump", answers: [{ choice: "Approve", pct: 50 }, { choice: "Disapprove", pct: 45 }] })),
  ];

  test("groups by pollster with sample-weighted average", () => {
    const result = computePollsterAverages(rows, "Donald Trump", "Approve");
    expect(result).toHaveLength(2);
    const ipsos = result.find((r) => r.pollster === "Ipsos")!;
    expect(ipsos.count).toBe(2);
    expect(ipsos.totalSample).toBe(3000);
    // (45*1000 + 48*2000) / 3000 = 147000/3000 = 47
    expect(ipsos.avgPct).toBeCloseTo(47, 0);
  });

  test("sorts by poll count descending", () => {
    const result = computePollsterAverages(rows, "Donald Trump", "Approve");
    expect(result[0]!.count).toBeGreaterThanOrEqual(result[1]!.count);
  });
});

describe("computePollAverages", () => {
  const rows: PollRow[] = [
    normalizeVoteHubPoll(makePoll({ id: "avg1", end_date: "2026-03-01", pollster: "Ipsos", sample_size: 1000, subject: "Donald Trump", answers: [{ choice: "Approve", pct: 44 }, { choice: "Disapprove", pct: 50 }] })),
    normalizeVoteHubPoll(makePoll({ id: "avg2", end_date: "2026-02-01", pollster: "Gallup", sample_size: 2000, subject: "Donald Trump", answers: [{ choice: "Approve", pct: 46 }, { choice: "Disapprove", pct: 48 }] })),
  ];

  test("computes sample-weighted average per choice across recent polls", () => {
    const result = computePollAverages(rows, "Donald Trump", 10);
    expect(result).toHaveLength(2);
    expect(result[0]!.choice).toBe("Disapprove");
    // Disapprove: (50*1000 + 48*2000) / 3000 = 146000/3000 ≈ 48.67
    expect(result[0]!.avgPct).toBeCloseTo(48.67, 0);
    expect(result[0]!.pollCount).toBe(2);
  });

  test("respects recentCount limit", () => {
    const result = computePollAverages(rows, "Donald Trump", 1);
    // Only the most recent poll (avg1, end_date 2026-03-01)
    const approve = result.find((r) => r.choice === "Approve")!;
    expect(approve.pollCount).toBe(1);
    expect(approve.avgPct).toBe(44);
  });
});
