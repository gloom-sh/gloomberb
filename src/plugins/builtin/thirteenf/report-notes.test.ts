import { describe, expect, test } from "bun:test";
import { filedPeriodText, summarizeTickerHoldings } from "./report-notes";

const row = (cik: string, value: number | null = 100, action: "held" | "exit" = "held") => ({ cik, value, action });
const quarter = { period: "2026-06-30", previousPeriod: "2026-03-31", holderCount: 3, newCount: 1, exitCount: 1 };

describe("13F ticker holdings summary", () => {
  test("a complete list states its total and no truncation", () => {
    const summary = summarizeTickerHoldings({
      ...quarter, offset: 0, limit: 50, hasMore: false, nextOffset: 25,
      loaded: [row("a"), row("b"), row("c"), row("d", null, "exit")],
    });
    expect(summary).toMatchObject({ total: 4, truncated: false, shownValue: 300 });
    expect(summary.notices).toEqual([
      "Period 2026-06-30 vs 2026-03-31 | 3 holders (1 new), 1 exited, total $300 | Value (USD) as reported at period end, not today's price",
    ]);
  });

  test("a page cut inside a fund's rows restarts at that fund", () => {
    // Fund b holds shares and calls; the limit cuts between them.
    const summary = summarizeTickerHoldings({
      ...quarter, offset: 0, limit: 2, hasMore: false, nextOffset: 25,
      loaded: [row("a"), row("b"), row("b"), row("c"), row("d", null, "exit")],
    });
    expect(summary).toMatchObject({ nextOffset: 1, truncated: true, shownFunds: 2 });
    expect(summary.notices[1]).toBe("Showing 2 of 4 funds, exits last; the 2 shown hold $200 | more: --offset 1 or --limit 200");
  });

  test("without a previous quarter there are no new or exited counts", () => {
    const summary = summarizeTickerHoldings({
      period: "2026-06-30", previousPeriod: null, holderCount: 60, newCount: 60, exitCount: 0,
      offset: 25, limit: 25, hasMore: true, nextOffset: 50,
      loaded: Array.from({ length: 25 }, (_, index) => row(`f${index}`)),
    });
    expect(summary.notices).toEqual([
      "Period 2026-06-30 | 60 holders | Value (USD) as reported at period end, not today's price",
      "Showing 26-50 of 60 funds; the 25 shown hold $2.5k | more: --offset 50 or --limit 200",
    ]);
  });
});

describe("13F filing dates", () => {
  test("say when the positions date from, when they were filed and the lag between", () => {
    expect(filedPeriodText("2026-06-30", "2026-08-14", "2026-03-31"))
      .toBe("Period 30 Jun · filed 14 Aug 2026 (45 days after quarter end) | QoQ vs 31 Mar");
    // A Q4 report is filed the next year, so the period keeps its own.
    expect(filedPeriodText("2025-12-31", "2026-02-17", "2025-09-30"))
      .toBe("Period 31 Dec 2025 · filed 17 Feb 2026 (48 days after quarter end) | QoQ vs 30 Sep 2025");
    expect(filedPeriodText("2026-03-31", "2026-05-15", "2025-12-31"))
      .toBe("Period 31 Mar · filed 15 May 2026 (45 days after quarter end) | QoQ vs 31 Dec 2025");
    expect(filedPeriodText("2026-06-30", null)).toBe("Period 2026-06-30");
  });
});
