import { expect, test } from "bun:test";
import { resolveStudies } from "./studies";
import type { ChartStudySpec, ResolvedSeries } from "./types";

// TQQQ and QQQ daily closes, 21 Sep to 21 Oct 2026 (CMP TQQQ,QQQ --rangePreset 1M).
const DAYS = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21"];
const TQQQ = [78.91, 80.83, 78.66, 78.58, 79.6, 77.04, 77.46, 78.03, 78.73, 81.01, 83.12, 84.25, 83.62, 80.23, 81.28, 79.61, 78.81, 74.12, 73.82, 68.21, 70.64, 70.41, 72.61];
const QQQ = [741.47, 747.46, 741.21, 741.1, 744.5, 736.53, 737.93, 739.77, 742.03, 749.58, 756.2, 759.66, 757.73, 747.58, 751.27, 746.04, 743.57, 728.95, 728.0, 709.8, 718.36, 717.63, 725.2];

function closes(id: string, symbol: string, values: readonly number[], days: readonly string[] = DAYS): ResolvedSeries {
  return {
    id, label: `${symbol} Close`, color: "#fff", unit: "USD/share", unitGroup: "price:USD",
    nativeFrequency: "daily", historyResolution: "1d", dataShape: "scalar", style: "line", transform: "raw", axis: "left",
    panelId: "main", interpolation: "none", observationKind: "market", listing: { symbol, exchange: "NASDAQ" },
    points: values.map((value, index) => {
      const date = new Date(`${days[index]}T00:00:00.000Z`);
      return { date, observedAt: date, value };
    }),
  };
}

const studies = (factor: number): ChartStudySpec[] => [
  { id: "leverage:fund", kind: "leverage", inputSeriesIds: ["index"], parameters: { factor }, panelId: "main", axis: "left" },
  { id: "leverage-decay:fund", kind: "leverage-decay", inputSeriesIds: ["fund", "index"], parameters: { factor }, panelId: "decay", axis: "auto" },
];

const latest = (series: ResolvedSeries | undefined) => series?.points.at(-1)?.value;

test("the daily line compounds the index fund's sessions, and the decay splits the fund's shortfall in two", () => {
  const result = resolveStudies([closes("fund", "TQQQ", TQQQ), closes("index", "QQQ", QQQ)], studies(3), "1d");
  expect(result.errors).toEqual([]);
  const [line, fund, compounding] = result.series;
  expect(line!.label).toBe("3× daily QQQ");
  expect(fund!.label).toBe("TQQQ decay vs 3× daily QQQ");
  expect(compounding!.label).toBe("3× daily QQQ decay vs 3× QQQ");
  // By hand from the closes: TQQQ -7.98%, 3x QQQ compounded daily -7.03%, 3x QQQ's -2.19% over the month -6.58%.
  expect(latest(line)).toBeCloseTo(-7.0262, 3);
  expect(latest(fund)).toBeCloseTo(-7.9838 - -7.0262, 3);
  expect(latest(compounding)).toBeCloseTo(-7.0262 - 3 * (725.2 / 741.47 - 1) * 100, 3);
  expect(line!.points[0]!.value).toBe(0);

  // An inverse fund compounds the opposite of each session.
  const inverse = resolveStudies([closes("fund", "SQQQ", TQQQ), closes("index", "QQQ", QQQ)], studies(-3), "1d");
  expect(inverse.series[0]!.label).toBe("-3× daily QQQ");
  expect(latest(inverse.series[0])).toBeCloseTo(5.6042, 3);
});

test("the line starts where the comparison does, not at the first bar loaded, and needs daily bars", () => {
  // Loaded from 21 Sep, compared from 1 Oct: the line is 0 on 1 Oct and compounds from there.
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  const end = Date.parse("2026-10-21T00:00:00.000Z");
  const anchors = new Map([["fund", { start, end }], ["index", { start, end }]]);
  const result = resolveStudies([closes("fund", "TQQQ", TQQQ), closes("index", "QQQ", QQQ)], studies(3), "1d", undefined, anchors);
  const line = result.series[0]!;
  expect(line.points[0]!.date.toISOString().slice(0, 10)).toBe("2026-10-01");
  expect(line.points[0]!.value).toBe(0);
  const from = DAYS.indexOf("2026-10-01");
  const expected = QQQ.slice(from).reduce((growth, close, index, list) => index === 0 ? growth : growth * (1 + 3 * (close / list[index - 1]! - 1)), 1);
  expect(latest(line)).toBeCloseTo((expected - 1) * 100, 6);
  expect(latest(result.series[1])).toBeCloseTo((72.61 / 78.73 - expected) * 100, 6);

  const weekly = resolveStudies([closes("fund", "TQQQ", TQQQ), { ...closes("index", "QQQ", QQQ), historyResolution: "1wk" }], studies(3), "1wk");
  expect(weekly.series).toEqual([]);
  expect(weekly.warnings[0]).toContain("3× daily needs daily bars");
});
