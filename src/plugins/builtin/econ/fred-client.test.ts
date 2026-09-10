import { describe, expect, test } from "bun:test";
import { resolveFredMapping, getRelatedTickers, projectFredHistory, fredHistoryUnits } from "./fred-series-map";

describe("resolveFredMapping", () => {
  test("maps exact US event titles", () => {
    const m = resolveFredMapping("CPI m/m", "US");
    expect(m).not.toBeNull();
    expect(m!.seriesId).toBe("CPIAUCSL");
    expect(m!.relatedTickers).toContain("TIP");
  });

  test("case insensitive matching", () => {
    expect(resolveFredMapping("cpi m/m", "US")?.seriesId).toBe("CPIAUCSL");
    expect(resolveFredMapping("CPI M/M", "US")?.seriesId).toBe("CPIAUCSL");
  });

  test("strips prefixes for fuzzy match", () => {
    expect(resolveFredMapping("Final GDP q/q", "US")?.seriesId).toBe("GDPC1");
    expect(resolveFredMapping("Prelim GDP q/q", "US")?.seriesId).toBe("GDPC1");
    expect(resolveFredMapping("Advance GDP q/q", "US")?.seriesId).toBe("GDPC1");
  });

  test("returns null for non-US events", () => {
    expect(resolveFredMapping("CPI m/m", "EU")).toBeNull();
    expect(resolveFredMapping("CPI m/m", "GB")).toBeNull();
  });

  test("returns null for unmapped events", () => {
    expect(resolveFredMapping("President Trump Speaks", "US")).toBeNull();
    expect(resolveFredMapping("Bank Holiday", "US")).toBeNull();
  });

  test("maps FOMC and Fed events", () => {
    expect(resolveFredMapping("Federal Funds Rate", "US")?.seriesId).toBe("DFEDTARU");
  });

  test("maps commodity indicators", () => {
    expect(resolveFredMapping("Crude Oil Inventories", "US")).toBeNull();
    expect(resolveFredMapping("Natural Gas Storage", "US")).toBeNull();
  });
});

describe("getRelatedTickers", () => {
  test("returns related tickers for known events", () => {
    const tickers = getRelatedTickers("CPI m/m", "US");
    expect(tickers).toContain("TIP");
    expect(tickers).toContain("DX-Y.NYB");
  });

});


test("calendar history shows inflation rates, payroll job changes, and annualized real GDP", () => {
  const cpi = resolveFredMapping("CPI y/y", "US")!;
  expect(cpi.seriesId).toBe("CPIAUCNS");
  const observations = [
    { date: "2025-07-01", value: 100 },
    { date: "2025-08-01", value: 101 },
    { date: "2026-06-01", value: 102 },
    { date: "2026-07-01", value: 103.4 },
  ];
  expect(projectFredHistory(observations, cpi).at(-1)?.value).toBeCloseTo(3.4);
  expect(fredHistoryUnits(cpi, "Index")).toBe("Percent change from year ago");
  const payrolls = resolveFredMapping("Non-Farm Employment Change", "US")!;
  expect(projectFredHistory([{ date: "2026-06-01", value: 160000 }, { date: "2026-07-01", value: 160120 }], payrolls)[0]?.value).toBe(120);
  expect(fredHistoryUnits(payrolls, "Thousands of Persons")).toBe("Thousands of Persons change from previous period");
  const gdp = resolveFredMapping("Advance GDP q/q", "US")!;
  expect(gdp.seriesId).toBe("GDPC1");
  expect(projectFredHistory([{ date: "2026-01-01", value: 100 }, { date: "2026-04-01", value: 101 }], gdp)[0]?.value).toBeCloseTo((1.01 ** 4 - 1) * 100);
  expect(resolveFredMapping("CPI", "US")).toBeNull();
});


test("calendar headline PPI uses final demand and cannot alias Conference Board to OECD", () => {
  expect(resolveFredMapping("PPI m/m", "US")?.seriesId).toBe("PPIFIS");
  expect(resolveFredMapping("CB Consumer Confidence", "US")).toBeNull();
});
