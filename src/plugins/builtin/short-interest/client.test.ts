import { expect, test } from "bun:test";
import type { CloudShortInterestPayload } from "../../../api-client/types";
import { createIdleEntry, type QueryEntry } from "../../../market-data/result-types";
import type { TickerFinancials } from "../../../types/financials";
import { loadShortInterest } from "./client";
import { loadShortInterestWithFloat } from "./watch-client";
const point = (settlementDate: string, sharesShort: number, daysToCover: number | null = null, shortPercentFloat?: number) => ({ settlementDate, sharesShort, daysToCover, shortPercentFloat, averageDailyVolume: null, previousSharesShort: null, changePercent: null, revised: false });
const client = (points: CloudShortInterestPayload["points"], source: "finra" | "gloom" = "gloom") => ({
  getCloudShortInterest: async () => ({ status: "success" as const, data: { symbol: "TEST", issueName: null, source, points } }),
});
test("latest settlements retain independent ratios and explicit float percentages", async () => {
  const result = await loadShortInterest("TEST", client([point("2026-08-14", 10_000_000), point("2026-08-31", 20_000_000, 2.3, 25)]));
  expect(result.source).toBe("gloom");
  expect(result.records[0]).toMatchObject({ shortRatio: null, averageDailyVolume: null, shortPercentFloat: null });
  expect(result.records[1]).toMatchObject({ settlementDate: new Date("2026-08-31"), sharesShort: 20_000_000, shortRatio: 2.3, averageDailyVolume: null, shortPercentFloat: 25 });
  for (const percent of [0, 150]) expect((await loadShortInterest("TEST", client([point("2026-08-31", 0, 0, percent)]))).records[0]?.shortPercentFloat).toBe(percent);
});
test("FINRA volume remains independent of rounded days to cover and invalid calendar dates are discarded", async () => {
  const valid = { ...point("2026-08-31", 20_000_000, 2.3), averageDailyVolume: 8_800_000 };
  const result = await loadShortInterest("TEST", client([point("2026-02-30", 1), valid], "finra"));
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ averageDailyVolume: 8_800_000, shortRatio: 2.3, shortPercentFloat: null });
});
test("confirmed empty settlements remain an empty result rather than a transport failure", async () => {
  expect(await loadShortInterest("TEST", { getCloudShortInterest: async () => ({ status: "empty", data: null }) }))
    .toMatchObject({ records: [], cloudSessionRequired: false });
});

const snapshot = (floatShares: number | undefined, statistics: Record<string, unknown> = {}): QueryEntry<TickerFinancials> => ({
  ...createIdleEntry<TickerFinancials>(),
  phase: "ready",
  data: { fundamentals: { floatShares, ...statistics }, annualStatements: [], quarterlyStatements: [], priceHistory: [] } as unknown as TickerFinancials,
});
test("the newest settlement reads its percent of float from the current float, as SIW does, and the settlements before it stay blank", async () => {
  const points = [point("2026-09-15", 39_000_000, 4.3), point("2026-09-30", 42_670_000, 3.98)];
  const withFloat = await loadShortInterestWithFloat("TEST", { client: client(points, "finra"), loadSnapshots: async () => [snapshot(461_000_000)] });
  expect(withFloat.records.map((record) => record.shortPercentFloat)).toEqual([null, expect.closeTo(9.256, 3)]);
  // A float that is another class's (smaller than the shares short), no snapshot, or a failed one: no percentage, the settlements intact.
  for (const loadSnapshots of [async () => [snapshot(1_000_000)], async () => [], async () => { throw new Error("offline"); }]) {
    const result = await loadShortInterestWithFloat("TEST", { client: client(points, "finra"), loadSnapshots });
    expect(result.records.map((record) => record.shortPercentFloat)).toEqual([null, null]);
    expect(result.records).toHaveLength(2);
  }
  // A percentage the source states is kept.
  const stated = await loadShortInterestWithFloat("TEST", { client: client([point("2026-09-30", 42_670_000, 3.98, 7)]), loadSnapshots: async () => [snapshot(461_000_000)] });
  expect(stated.records[0]?.shortPercentFloat).toBe(7);
});
test("a settlement served with the share count known when it was published reads its percent of float on that day's float", async () => {
  // Today's float is 461.24M of a 504.5M cover count (91.4% floats). The August settlement was published on the June count.
  const counted = (settlementDate: string, sharesShort: number, sharesOutstanding?: number, sharesOutstandingAsOf?: string) =>
    ({ ...point(settlementDate, sharesShort, 4), ...(sharesOutstanding ? { sharesOutstanding, sharesOutstandingAsOf } : {}) });
  const points = [
    counted("2026-07-31", 50_000_000),
    counted("2026-08-14", 54_040_000, 448_691_257, "2026-06-05"),
    counted("2026-09-30", 42_673_721, 504_500_990, "2026-09-03"),
  ];
  // The float is the source's, undated: only the earlier rows' counts carry a day.
  const today = snapshot(461_240_030, { sharesOutstanding: 504_500_990 });
  const { records } = await loadShortInterestWithFloat("TEST", { client: client(points, "finra"), loadSnapshots: async () => [today] });
  const august = 54_040_000 / (448_691_257 * (461_240_030 / 504_500_990)) * 100;
  expect(records.map((record) => record.shortPercentFloat)).toEqual([null, expect.closeTo(august, 6), expect.closeTo(9.252, 3)]);
  expect(records.map((record) => record.floatAsOf ?? null)).toEqual([null, "2026-06-05", null]);
  // Point in time (--as-of): the newest too is read on its own day's count, not on today's float with its statistics.
  const statistics = { shortInterestDate: "2026-09-30", shortPercentOfFloat: 0.095 };
  const cut = await loadShortInterestWithFloat("TEST", {
    client: client(points, "finra"), pointInTime: true,
    loadSnapshots: async () => [snapshot(461_240_030, { sharesOutstanding: 504_500_990, ...statistics })],
  });
  expect(cut.records.at(-1)?.shortPercentFloat).toBeCloseTo(9.252, 3);
});
test("the newest settlement takes the statistics' percent of float when they are of the same settlement, as SIW and the overview do", async () => {
  // GME: 42.67M short; the statistics divide by the float served at the 449.1M shares outstanding.
  const points = [point("2026-09-15", 39_000_000, 4.3), point("2026-09-30", 42_673_721, 3.98)];
  const statistics = { shortInterestDate: "2026-09-30", shortPercentOfFloat: 42_673_721 / 449_100_000 };
  const same = await loadShortInterestWithFloat("TEST", { client: client(points, "finra"), loadSnapshots: async () => [snapshot(461_240_030, statistics)] });
  expect(same.records.map((record) => record.shortPercentFloat)).toEqual([null, expect.closeTo(9.502, 3)]);
  // Statistics of an older settlement are not mixed in: the shares short over the current float.
  const older = await loadShortInterestWithFloat("TEST", {
    client: client(points, "finra"),
    loadSnapshots: async () => [snapshot(461_240_030, { ...statistics, shortInterestDate: "2026-09-15" })],
  });
  expect(older.records.at(-1)?.shortPercentFloat).toBeCloseTo(9.252, 3);
});
