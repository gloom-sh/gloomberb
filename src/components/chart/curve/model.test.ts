import { expect, test } from "bun:test";
import { buildCompositeChartScene } from "../composite/scene";
import { buildCurveChart, curvePlotWidth, curveSlope, curveStrip, curveSurfaceMinRows, curveTableRows, historyStatistics, type CurveSeries } from "./model";

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

test("axis ticks leave room for edge labels that pin inward", () => {
  const day = 86_400_000;
  const start = Date.parse("2026-10-20");
  const points = [0, 92, 1000].map((offset, index) => ({ id: String(index), label: new Date(start + offset * day).toISOString().slice(2, 10), x: start + offset * day, value: 1 }));
  // At 120 columns the second expiry sits eleven columns in: clear of a centered label, not of the pinned first one.
  const chart = buildCurveChart([{ id: "current", label: "Latest", asOf: null, points }], 120, ["green"]);
  expect(chart.ticks.map((tick) => tick.label)).toEqual(["26-10-20", "29-07-16"]);
});

const maturities: CurveSeries = { id: "yield", label: "Yield", points: [0.25, 1, 4, 16].map((years, index) => ({
  id: `${years}`, label: `${years}Y`, x: years, value: 4 + index / 10 })) };

test("a log axis spreads maturities by ratio and an even axis gives every row one slot", () => {
  const log = buildCurveChart([maturities], 80, ["green"], { xScale: "log" });
  [0, 1 / 3, 2 / 3, 1].forEach((ratio, index) => expect(log.ratioOf([0.25, 1, 4, 16][index]!)).toBeCloseTo(ratio, 12));
  expect(log.fromDate(log.toDate(4))).toBeCloseTo(4, 9);
  const marker: CurveSeries = { id: "meeting", label: "Meeting", role: "marker", points: [{ id: "m", label: "Meeting", x: 2.5, value: 4 }] };
  const even = buildCurveChart([{ ...maturities, points: maturities.points.map((point, index) => ({ ...point, x: [1, 2, 10, 30][index]! })) }, marker],
    80, ["green", "gray"], { xScale: "even" });
  expect([1, 2, 10, 30].map((x) => even.ratioOf(x))).toEqual([0, 1 / 3, 2 / 3, 1]);
  // A marker between two rows sits between their slots, drawn as a point and never labelling the axis.
  expect(even.ratioOf(2.5)).toBeCloseTo(1 / 3 + 0.5 / 8 / 3, 12);
  expect(even.fromDate(even.toDate(2.5))).toBeCloseTo(2.5, 9);
  expect(even.series[1]!.style).toBe("points");
  expect(even.ticksAt(200).map((tick) => tick.label)).not.toContain("Meeting");
  // Maturities at or below zero cannot sit on a log axis, so it reads by value.
  const linear = buildCurveChart([{ ...maturities, points: [{ id: "0", label: "0", x: 0, value: 1 }, ...maturities.points] }], 80, ["green"], { xScale: "log" });
  expect(linear.ratioOf(8)).toBeCloseTo(0.5, 12);
});

test("references and markers are drawn but never rows", () => {
  const reference: CurveSeries = { id: "policy", label: "Policy", role: "reference", points: [
    { id: "a", label: "", x: 0.25, value: 4 }, { id: "b", label: "", x: 16, value: 4 }] };
  const rows = curveTableRows([maturities, reference]);
  expect(rows.map((row) => row.id)).toEqual(["0.25", "1", "4", "16"]);
  expect(rows[0]!.points.policy).toBeUndefined();
  expect(buildCurveChart([maturities, reference], 80, ["green", "gray"]).series.map((entry) => entry.id)).toEqual(["yield", "policy"]);
});

test("ticks are culled at the plot's width, which leaves the value axis its labels", () => {
  const chart = buildCurveChart([maturities], 40, ["green"], { xScale: "log" });
  const format = (value: number) => `${value.toFixed(2)}%`;
  const plot = curvePlotWidth(chart.series, 40, 6, format);
  // "4.30%" is five cells, plus the gap before the plot.
  expect(plot).toBe(34);
  expect(chart.ticksAt(plot).map((tick) => tick.label)).toEqual(["0.25Y", "1Y", "4Y", "16Y"]);
  expect(chart.ticksAt(16).map((tick) => tick.label)).toEqual(["0.25Y", "16Y"]);
});

test("the strip and the minimum rows describe a curve for the chart-table kit", () => {
  const strip = curveStrip([maturities], (value) => value.toFixed(2), { caption: "Yield % by maturity", selectedPointId: "1" });
  expect(strip).toEqual({ label: "Yield % by maturity", values: [4, 4.1, 4.2, 4.3], value: "1Y 4.10", color: undefined });
  expect(curveStrip([maturities], String)?.value).toBe("16Y 4.3");
  expect(curveStrip([{ ...maturities, points: maturities.points.slice(0, 1) }], String)).toBeNull();
  expect(curveSurfaceMinRows({ series: [maturities], width: 80, caption: "Yield %" })).toBe(7);
  const many = Array.from({ length: 6 }, (_, index) => ({ ...maturities, id: `s${index}`, label: `Series number ${index}` }));
  expect(curveSurfaceMinRows({ series: many, width: 40 })).toBeGreaterThan(7);
});
