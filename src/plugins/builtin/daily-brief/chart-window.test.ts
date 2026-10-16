import { describe, expect, test } from "bun:test";
import { esChartMarkers, esChartStart, esMarkerRatio } from "./chart-window";

// Monday 5 Oct 2026, 16:52 and 02:00 New York (EDT, UTC-4). Sunday 22:00 is still the 4th there.
const MONDAY_AFTERNOON = Date.parse("2026-10-05T20:52:00Z");
const MONDAY_PREDAWN = Date.parse("2026-10-05T06:00:00Z");
const SUNDAY_NIGHT = Date.parse("2026-10-05T02:00:00Z");

describe("es chart window", () => {
  test("a weekday afternoon starts at the 04:00 New York premarket", () => {
    expect(new Date(esChartStart(MONDAY_AFTERNOON)).toISOString()).toBe("2026-10-05T08:00:00.000Z");
  });

  test("before 04:00 New York the chart starts at the Globex open", () => {
    expect(new Date(esChartStart(MONDAY_PREDAWN)).toISOString()).toBe("2026-10-04T22:00:00.000Z");
  });

  test("sunday evening starts at that night's Globex open", () => {
    expect(new Date(esChartStart(SUNDAY_NIGHT)).toISOString()).toBe("2026-10-04T22:00:00.000Z");
  });

  test("the cash open is marked once the session is underway, and not before 04:00", () => {
    expect(esChartMarkers(esChartStart(MONDAY_AFTERNOON), MONDAY_AFTERNOON).map((marker) => marker.label)).toEqual(["Open"]);
    expect(esChartMarkers(esChartStart(MONDAY_PREDAWN), MONDAY_PREDAWN)).toEqual([]);
  });

  test("a marker keeps the right margin clear and stays off the series when it is outside it", () => {
    expect(esMarkerRatio(500, 0, 1000, 0.06)).toBeCloseTo(0.47, 10);
    expect(esMarkerRatio(-1, 0, 1000, 0.06)).toBeNull();
  });
});
