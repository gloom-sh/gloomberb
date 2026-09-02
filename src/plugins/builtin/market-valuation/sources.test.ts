import { describe, expect, test } from "bun:test";
import { parseFredGraphCsv, yahooChartToDatedSeries } from "./sources";

describe("parseFredGraphCsv", () => {
  test("parses values and keeps blank FRED cells as null", () => {
    const csv = "observation_date,NCBEILQ027S\n1945-10-01,103694\n1946-01-01,\n1946-04-01,.\n1946-07-01,110000\n";
    const parsed = parseFredGraphCsv(csv, "NCBEILQ027S");
    expect(parsed.provenance).toBe("fred-csv");
    expect(parsed.observations).toEqual([
      { date: "1945-10-01", value: 103694 },
      { date: "1946-01-01", value: null },
      { date: "1946-04-01", value: null },
      { date: "1946-07-01", value: 110000 },
    ]);
  });

  test("rejects HTML error pages", () => {
    expect(() => parseFredGraphCsv("<html><body>nope</body></html>", "GDP")).toThrow();
  });
});

describe("yahooChartToDatedSeries", () => {
  test("keeps finite closes and drops null bars", () => {
    const payload = {
      chart: {
        result: [{
          timestamp: [1_700_000_000, 1_700_086_400, 1_700_172_800],
          indicators: { quote: [{ close: [100.5, null, 102.25] }] },
        }],
      },
    } as never;
    const parsed = yahooChartToDatedSeries(payload, "WILL5000PRFC");
    expect(parsed.provenance).toBe("yahoo");
    expect(parsed.observations.map((o) => o.value)).toEqual([100.5, 102.25]);
  });
});
