import { expect, test } from "bun:test";
import { findCatalogSeries } from "../../../cli/series-search";
import { CENTRAL_BANK_SERIES, policyRatePoints } from "./series";

test("the catalog names who publishes each policy rate: FRED for the Fed and the ECB, the BIS for the rest", () => {
  const matches = findCatalogSeries([{ series: CENTRAL_BANK_SERIES }], "policy rate");
  expect(matches).toHaveLength(20);
  const publisher = (id: string) => matches.find((match) => match.id === id)?.publisher;
  expect([publisher("policy-rate:us"), publisher("policy-rate:ea")]).toEqual(["FRED", "FRED"]);
  expect(matches.filter((match) => !match.id.endsWith(":us") && !match.id.endsWith(":ea")).map((match) => match.publisher))
    .toEqual(Array(18).fill("BIS"));
  // The publisher is searchable, as it is for the FRED series.
  expect(findCatalogSeries([{ series: CENTRAL_BANK_SERIES }], "bis")).toHaveLength(18);
});

// Japan's policy rate stopped at BIS's 10 Nov 2026 on a chart of 19 Nov, while the BoJ's site showed 1.25% that day.
test("a policy rate runs to the day the bank's site last showed it, unless a decision since may have changed it", () => {
  const history = [{ date: "2026-11-09", value: 1.25 }, { date: "2026-11-10", value: 1.25 }];
  const row = { history, status: "available" as const, value: 1.25, confirmedAt: "2026-11-19T06:25:34.596Z" };
  expect(policyRatePoints(row).slice(-2)).toEqual([{ date: "2026-11-10", value: 1.25 }, { date: "2026-11-19", value: 1.25 }]);
  // A decision BIS has not reported, no confirmation, one no later than the last observation, or another level: as observed.
  for (const other of [{ status: "stale" as const }, { confirmedAt: null }, { confirmedAt: "2026-11-10T09:00:00Z" }, { value: 1.5 }]) {
    expect(policyRatePoints({ ...row, ...other })).toEqual(history);
  }
});
