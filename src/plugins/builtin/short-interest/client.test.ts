import { expect, test } from "bun:test";
import type { CloudShortInterestPayload } from "../../../api-client/types";
import { loadShortInterest } from "./client";
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
