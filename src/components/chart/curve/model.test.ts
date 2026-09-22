import { expect, test } from "bun:test";
import { buildCompositeChartScene } from "../composite/scene";
import { buildCurveChart, curveSlope, curveTableRows, historyStatistics, type CurveSeries } from "./model";

const primary: CurveSeries = {
  id: "current", label: "Today", asOf: "2026-09-21",
  points: [
    { id: "front", label: "Oct", x: 10, value: 4 },
    { id: "missing", label: "Nov", x: 20, value: null },
    { id: "back", label: "Jan", x: 40, value: 3.5 },
  ],
};

test("numeric curve coordinates preserve null gaps and each ghost's independent maturities", () => {
  const ghost: CurveSeries = { id: "week", label: "1W", asOf: "2026-09-14", points: [
    { id: "front", label: "Oct", x: 17, value: 4.25 },
    { id: "back", label: "Jan", x: 47, value: 4 },
  ] };
  const chart = buildCurveChart([primary, ghost], 70, ["green", "gray"]);
  const scene = buildCompositeChartScene(chart.series, [{ id: "main" }], { width: 70, height: 12, rightOffsetRatio: 0 })!;
  expect(scene.timeScale.kind).toBe("calendar");
  const [today, week] = scene.panels[0]!.series;
  expect(today!.points.map((point) => point.value)).toEqual([4, 3.5]);
  expect(today!.points[1]!.breakBefore).toBe(true);
  expect(today!.points[1]!.xRatio).toBeCloseTo(30 / 37, 10);
  expect(week!.points[0]!.xRatio).toBeCloseTo(7 / 37, 10);
  expect(week!.points[1]!.xRatio).toBe(1);
  expect(chart.fromDate(chart.toDate(17))).toBeCloseTo(17, 9);
  const rows = curveTableRows([primary, ghost]);
  expect(rows[0]!.points.week?.x).toBe(17);
  expect(rows[1]!.points.current?.value).toBeNull();
  expect(rows[1]!.points.week).toBeUndefined();
});

test("single-node, epoch and invalid values retain truthful curve domains", () => {
  const x = Date.parse("2026-10-28");
  const series = { ...primary, points: [
    { id: "a", label: "Oct", x, value: 4 },
    { id: "b", label: "Dec", x: x + 42 * 86_400_000, value: NaN },
    { id: "bad", label: "Bad", x: NaN, value: 9 },
  ] };
  const chart = buildCurveChart([series], 30, ["green"]);
  expect(chart.series[0]!.points.map((point) => point.value)).toEqual([4, null]);
  expect(chart.max - chart.min).toBe(42 * 86_400_000);
  const single = buildCurveChart([{ ...primary, points: primary.points.slice(0, 1) }], 30, ["green"]);
  expect(single.fromDate(single.toDate(10))).toBe(10);
  expect(single.ticks).toEqual([{ label: "Oct", ratio: 0 }]);
});

test("slope cannot substitute a different front tenor or compare different observation dates", () => {
  expect(curveSlope(primary, { multiplier: 100 })).toBe(-50);
  expect(curveSlope(primary, { frontId: "missing" })).toBeNull();
  expect(curveSlope(primary, { backId: "absent" })).toBeNull();
  expect(curveSlope({ ...primary, asOf: null })).toBeNull();
  expect(curveSlope({ ...primary, points: primary.points.map((point) => ({ ...point,
    asOf: point.id === "back" ? "2026-09-18" : primary.asOf })) })).toBeNull();
});

test("midrank statistics filter future and invalid points, apply windows, and deduplicate revisions", () => {
  const history = [
    { date: "2026-08-01", value: -100 },
    { date: "2026-09-19", value: 1 },
    { date: "2026-09-20", value: 2 },
    { date: "2026-09-20", value: 3 },
    { date: "2026-09-21", value: 3 },
    { date: "2026-09-22", value: 4 },
    { date: "2026-09-23", value: 100 },
    { date: "invalid", value: 200 },
    { date: "2026-09-18", value: Infinity },
  ];
  expect(historyStatistics(history, 3, { asOf: "2026-09-22", windowDays: 3 })).toEqual({
    percentile: 50, rank: 2, count: 4, min: 1, max: 4, mean: 2.75,
    startDate: "2026-09-19", endDate: "2026-09-22",
  });
  expect(historyStatistics(history, 3, { asOf: "2026-09-21", startDate: "2026-09-20" }).percentile).toBe(50);
  expect(historyStatistics(history, null, { asOf: "2026-09-22", windowDays: 3 }).percentile).toBeNull();
  expect(historyStatistics([], 3).min).toBeNull();
  expect(historyStatistics(history, 3, { asOf: "invalid" }).count).toBe(0);
});

test("history corrections remove observations and invalid calendar dates never overflow into a month", () => {
  const history = [
    { date: "2026-02-28", value: 3 },
    { date: "2026-02-28", value: null },
    { date: "2026-02-30", value: 100 },
    { date: "2026-03-01", value: 4 },
    { date: "2026-03-02T12:00:00.000Z", value: 5 },
  ];
  const result = historyStatistics(history, 4, { asOf: "2026-03-02" });
  expect(result.count).toBe(2);
  expect(result.mean).toBe(4.5);
  expect(result.startDate).toBe("2026-03-01");
  expect(historyStatistics(history, 4, { asOf: "2026-02-30" }).count).toBe(0);
});


test("off-chart comparisons retain table context without expanding either chart axis", () => {
  const series: CurveSeries[] = [
    { id: "now", label: "Latest", points: [{ id: "one", label: "1Y", x: 1, value: 4 }, { id: "two", label: "2Y", x: 2, value: 3.9 }] },
    { id: "old", label: "1Y", chartVisible: false, points: [{ id: "one", label: "1Y", x: 1, value: 15 }, { id: "ten", label: "10Y", x: 10, value: 16 }] },
  ];
  const chart = buildCurveChart(series, 80, ["green", "gray"]);
  expect(chart.series.map((row) => row.id)).toEqual(["now"]);
  expect([chart.min, chart.max]).toEqual([1, 2]);
  expect(curveTableRows(series)[0]?.points.old?.value).toBe(15);
});
