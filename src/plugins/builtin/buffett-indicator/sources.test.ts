import { describe, expect, test } from "bun:test";
import { parseFredGraphCsv, yahooChartToDatedSeries } from "./sources";

describe("parseFredGraphCsv", () => {
  test("parses values and keeps blank FRED cells as null", () => {
    const data = parseFredGraphCsv(
      "observation_date,NCBEILQ027S\n1945-10-01,103694\n1946-01-01,\n2024-01-01,5500000\n",
      "NCBEILQ027S",
    );
    expect(data.provenance).toBe("fred-csv");
    expect(data.observations).toEqual([
      { date: "1945-10-01", value: 103694 },
      { date: "1946-01-01", value: null },
      { date: "2024-01-01", value: 5500000 },
    ]);
  });

  test("rejects HTML error pages", () => {
    expect(() => parseFredGraphCsv("<!DOCTYPE html>", "WILL5000PRFC")).toThrow("Unexpected FRED CSV");
  });
});

describe("yahooChartToDatedSeries", () => {
  test("keeps finite closes and drops null bars", () => {
    const data = yahooChartToDatedSeries({
      chart: {
        result: [{
          meta: { longName: "Wilshire 5000 Total Market Index" },
          timestamp: [600000000, 600086400, 600172800],
          indicators: { quote: [{ close: [2718.5, null, 2800] }] },
        }],
      },
    }, "WILL5000PRFC");
    expect(data.provenance).toBe("yahoo");
    expect(data.observations).toEqual([
      { date: "1989-01-05", value: 2718.5 },
      { date: "1989-01-07", value: 2800 },
    ]);
  });
});
