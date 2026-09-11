import { expect, test } from "bun:test";
import type { CloudFredSeriesInfoPayload } from "../api-client";
import { fredCreditCoverageNotice } from "./economic";

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
