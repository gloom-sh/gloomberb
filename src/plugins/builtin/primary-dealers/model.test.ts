import { describe, expect, test } from "bun:test";
import {
  buildDealerRows,
  changeSeriesId,
  dealerRange,
  dealerRowLabel,
  pointsInRange,
  sumSeries,
  type SeriesPoint,
} from "./model";

const WEEK = "2026-10-07";

/** Latest figures as the release serves them: a level and, under the key plus "C", its change from the week before. */
function latest(levels: Record<string, [number, number | null]>, asOf = WEEK): Map<string, SeriesPoint> {
  const points = new Map<string, SeriesPoint>();
  for (const [key, [value, change]] of Object.entries(levels)) {
    points.set(key, { asOf, value });
    if (change != null) points.set(changeSeriesId(key), { asOf, value: change });
  }
  return points;
}

const TIPS = ["PDPOSTIPS-L2", "PDPOSTIPS-G2", "PDPOSTIPS-G6L11", "PDPOSTIPS-G11"];

describe("buildDealerRows", () => {
  test("a total comes first and its breakdown follows it, indented, with the total named as its parent", () => {
    const rows = buildDealerRows(latest({
      "PDPOSGST-TOT": [444_683, 12_651],
      "PDPOSGS-B": [109_081, 9_000],
      "PDPOSFGS-TOT": [18_087, -100],
    }));
    expect(rows.map((row) => [dealerRowLabel(row), row.parent])).toEqual([
      ["Treasuries", null],
      ["\u00a0\u00a0Bills", "Treasuries"],
      ["Agency & GSE", null],
    ]);
  });

  test("a row summed from several series needs all of them, and adds their published changes", () => {
    const levels: Record<string, [number, number | null]> = {
      [TIPS[0]!]: [24_842, 100], [TIPS[1]!]: [7_484, -50], [TIPS[2]!]: [2_706, 10], [TIPS[3]!]: [494, 0],
    };
    const [tips] = buildDealerRows(latest(levels));
    expect(tips).toMatchObject({ label: "TIPS", latest: 35_526, change: 60, previous: 35_466, asOf: WEEK });

    const { [TIPS[3]!]: _dropped, ...missingOne } = levels;
    expect(buildDealerRows(latest(missingOne))).toEqual([]);
  });

  test("a series with no published change has a level and no change or previous", () => {
    const [bills] = buildDealerRows(latest({ "PDPOSGS-B": [109_081, null] }));
    expect(bills).toMatchObject({ latest: 109_081, change: null, previous: null });
  });

  test("a sum of series from different weeks is not a row, and a change from another week is not its change", () => {
    const stale = latest({ [TIPS[0]!]: [1, 1], [TIPS[1]!]: [1, 1], [TIPS[2]!]: [1, 1], [TIPS[3]!]: [1, 1] });
    stale.set(TIPS[3]!, { asOf: "2026-09-30", value: 1 });
    expect(buildDealerRows(stale)).toEqual([]);

    const oldChange = latest({ "PDPOSGS-B": [109_081, 15_636] });
    oldChange.set(changeSeriesId("PDPOSGS-B"), { asOf: "2026-09-30", value: 15_636 });
    expect(buildDealerRows(oldChange)[0]).toMatchObject({ latest: 109_081, change: null, previous: null });
  });

  test("fails keep their deliver and receive pairs, per asset, as plain rows", () => {
    const rows = buildDealerRows(latest({
      "PDFTD-USTET": [121_178, -9_511],
      "PDFTR-USTET": [137_453, 8_173],
      "PDFTD-OM": [5_145, 118],
    }));
    expect(rows.map((row) => [row.tab, row.label, row.depth, row.change])).toEqual([
      ["fails", "Treasuries ex-TIPS, fails to deliver", 0, -9_511],
      ["fails", "Treasuries ex-TIPS, fails to receive", 0, 8_173],
      ["fails", "Other MBS, fails to deliver", 0, 118],
    ]);
  });
});

describe("history", () => {
  const points = (...entries: Array<[string, number]>): SeriesPoint[] => entries.map(([asOf, value]) => ({ asOf, value }));

  test("a sum has the weeks every series has, oldest first", () => {
    expect(sumSeries([
      points(["2026-09-30", 3], ["2026-09-23", 1]),
      points(["2026-09-23", 10], ["2026-09-30", 20], ["2026-10-07", 30]),
    ])).toEqual(points(["2026-09-23", 11], ["2026-09-30", 23]));
  });

  test("a range counts back from the newest week, and All is everything", () => {
    const weekly = Array.from({ length: 120 }, (_, index) => ({
      asOf: new Date(Date.UTC(2024, 6, 3) + index * 7 * 86_400_000).toISOString().slice(0, 10),
      value: index,
    }));
    expect(pointsInRange(weekly, "ALL")).toHaveLength(120);
    const year = pointsInRange(weekly, "1Y");
    expect(year).toHaveLength(53);
    expect(year.at(-1)).toEqual(weekly.at(-1)!);
    expect(pointsInRange(weekly, "6M").length).toBeLessThan(year.length);
    expect(dealerRange("bogus")).toBe("1Y");
  });
});
