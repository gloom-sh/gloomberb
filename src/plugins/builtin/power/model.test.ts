import { expect, test } from "bun:test";
import { powerQuery } from "./query";
import { generationRows } from "./generation";
import { validatePowerBoard, validatePowerHistory } from "./client";
import { historyRows, historySeries, powerFigures, projectRows } from "./model";
import { powerBoard, powerPoint, powerProject } from "./test-fixture";

test("history changes never bridge independent sources, fuels, statuses or historical benchmarks", () => {
  const points = [powerPoint({ observedAt: "2026-10-01T12:00:00Z", capacityMw: 100 }), powerPoint({ observedAt: "2026-10-02T12:00:00Z", capacityMw: 125 }),
    powerPoint({ sourceId: "other", capacityMw: 300 }), powerPoint({ fuel: "solar", capacityMw: 400 }), powerPoint({ status: "withdrawn", capacityMw: 50 }),
    powerPoint({ historical: true, basis: "published", period: "2020", capacityMw: 25 })];
  const rows = historyRows(points);
  expect(rows.filter((r) => r.changeMw !== null).map((r) => r.changeMw)).toEqual([25]);
  expect(historySeries(points, points[1], "#fff")).toEqual([]);
  points.push(powerPoint({ observedAt: "2026-10-03T12:00:00Z", capacityMw: 130 }));
  expect(historySeries(points, points[1], "#fff")[0]!.points.map((p) => p.value)).toEqual([100, 125, 130]);
});

test("annual history plots the stated benchmark period and leaves observation time intact", () => {
  const points = [2020, 2021, 2022].map((year) => powerPoint({ historical: true, basis: "published", period: String(year), capacityMw: year }));
  const series = historySeries(points, points[0], "#fff")[0]!;
  expect(series.points.map((p) => p.date.getUTCFullYear())).toEqual([2020, 2021, 2022]);
  expect(series.points.every((p) => p.observedAt?.getUTCFullYear() === 2026)).toBe(true);
});

test("zero capacity is distinct from missing capacity and figures include only returned scope", () => {
  const rows = projectRows([powerProject({ capacityMw: 0 }), powerProject({ capacityMw: null })]);
  expect(rows.map((r) => r.cells.capacityMw)).toEqual([0, null]);
  expect(powerFigures(powerBoard().aggregates)[0]!.value).toBe("125.5");
});

test("API boundary rejects nonfinite MW, invalid evidence links and impossible or stalled pages", () => {
  expect(() => validatePowerBoard(powerBoard({ projects: [powerProject({ capacityMw: NaN })] }))).toThrow();
  expect(() => validatePowerBoard(powerBoard({ projects: [powerProject({ sourceUrl: "javascript:alert(1)" })] }))).toThrow();
  expect(() => validatePowerBoard(powerBoard({ hasMore: true, nextOffset: null }))).toThrow();
  const bad = powerBoard(); bad.rates[0]!.completionRate = 25;
  expect(() => validatePowerBoard(bad)).toThrow();
  expect(() => validatePowerHistory({ generatedAt: "2026-10-04", access: "full", points: [powerPoint({ observedAt: "invalid" })], locked: 0, hasMore: false, nextOffset: null })).toThrow();
});

test("missing capacities break both the chart and change sequence instead of manufacturing zeros", () => {
  const points = [2019, 2020, 2021, 2022].map((year, index) => powerPoint({ historical: true, basis: "published", period: String(year), unknownCapacity: index === 1 ? 1 : 0, capacityMw: index === 1 ? 0 : year }));
  expect(historyRows(points).map((p) => p.changeMw)).toEqual([1, null, null, null]);
  expect(historySeries(points, points[0], "#fff")[0]!.points.map((p) => p.value)).toEqual([2019, null, 2021, 2022]);
});

test("monthly generation preserves negative energy and gaps without counting absent months as zero", () => {
  const rows = generationRows(powerProject({ period: "2024", metrics: { generationJanuaryMwh: -50, generationFebruaryMwh: 100, generationAprilMwh: 125 } }));
  expect(rows).toHaveLength(12);
  expect(rows.slice(0, 4).map((row) => [row.value, row.change])).toEqual([[-50, null], [100, 150], [null, null], [125, null]]);
  expect(generationRows(powerProject({ period: null }))).toEqual([]);
});

test("capacity contexts discard inactive benchmarks and use their native metric sorting", () => {
  expect(powerQuery({ tab: "capacity", context: "generation", sourceId: "us-lbnl", historical: true })).toMatchObject({ sourceId: "us-eia923", kind: "capacity", historical: false, sort: "generationMwh" });
  expect(powerQuery({ tab: "capacity", context: "utility", sourceId: "us-lbnl-annual" })).toMatchObject({ sourceId: "us-eia861", kind: "utility", sort: "salesMwh" });
  expect(powerQuery({ tab: "capacity", context: "utility", sort: "winterPeakDemandMw", direction: "asc" })).toMatchObject({ sort: "winterPeakDemandMw", direction: "asc" });
});
