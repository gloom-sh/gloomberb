import { expect, test } from "bun:test";
import type { CloudFredSeriesInfoPayload } from "../api-client";
import { extractFredSeries, fredCreditCoverageNotice } from "./economic";

const info: CloudFredSeriesInfoPayload = {
  id: "BAMLC0A0CM", title: "ICE BofA US Corporate Index Option-Adjusted Spread",
  units: "Percent", frequency: "Daily, Close", seasonalAdjustment: "Not Seasonally Adjusted", source: "",
  observationStart: "2023-09-12", observationEnd: "2026-09-10",
  notes: "Starting in April 2026, this series will only include 3 years of observations. For more data, go to the source.",
};

test("credit coverage uses declared source dates and only warns before the visible boundary", () => {
  for (const start of [null, Date.parse("2020-01-01"), Date.parse("2023-09-11")]) {
    expect(fredCreditCoverageNotice("bamlc0a0cm", info, start)).toContain("2023-09-12 to 2026-09-10");
    expect(fredCreditCoverageNotice("BAMLC0A0CM", info, start)).toContain("3 years");
  }
  expect(fredCreditCoverageNotice(info.id, info, Date.parse("2023-09-12"))).toBeNull();
  expect(fredCreditCoverageNotice(info.id, info, Date.parse("2025-01-01"))).toBeNull();
  expect(fredCreditCoverageNotice(info.id, { ...info, notes: "" }, null)).not.toContain("3 years");
  // A future source extension must move the boundary instead of enforcing a rolling date guess.
  expect(fredCreditCoverageNotice(info.id, { ...info, observationStart: "1996-12-31", notes: "" }, Date.parse("2020-01-01"))).toBeNull();
});

test("missing or mismatched coverage cannot claim a retention boundary", () => {
  for (const metadata of [null, { ...info, id: "BAMLH0A0HYM2" }, { ...info, observationStart: undefined },
    { ...info, observationStart: "2023-02-30" }, { ...info, observationStart: "2027-01-01" }]) {
    expect(fredCreditCoverageNotice(info.id, metadata, null)).toBeNull();
  }
  expect(fredCreditCoverageNotice("CPIAUCSL", { ...info, id: "CPIAUCSL" }, null)).toBeNull();
});

test("usable observations outside declared coverage invalidate dates without inventing new source bounds", () => {
  for (const point of [{ date: "2026-09-14", value: 0 }, { date: "2023-09-11", value: -0.1 }]) {
    const notice = fredCreditCoverageNotice(info.id, info, null, [point]);
    expect(notice).toContain("does not match");
    expect(notice).toContain("3 years");
    expect(notice).not.toContain("2023-09-12 to 2026-09-10");
    expect(notice).not.toContain("Earlier dates are unavailable");
  }
  expect(fredCreditCoverageNotice(info.id, info, null, [
    { date: "2026-09-14", value: null }, { date: "2023-09-11", value: NaN },
    { date: "2026-02-30", value: 1 }, { date: "2026-09-10", value: 0 },
  ])).toContain("2023-09-12 to 2026-09-10");
});

test("the newest observation's release is carried for the report line, never as its availability", () => {
  for (const timestampMode of ["period-end", "available-at"] as const) {
    const points = extractFredSeries([
      { date: "2026-08-01", value: 1330 },
      { date: "2026-09-01", value: 1412, releasedOn: "2026-10-20" },
    ], { providerId: "fred", timestampMode });
    // Drawn at its period like the others, on a calendar or a market's time scale.
    expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.availableAt ?? null, point.releasedOn ?? null]))
      .toEqual([["2026-08-01", null, null], ["2026-09-01", null, "2026-10-20"]]);
  }
});
