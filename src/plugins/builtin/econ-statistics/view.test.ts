import { expect, test } from "bun:test";
import { projectStat } from "./view";
import { findStat } from "./stats";
import { fitTrend } from "./trend";

test("1Y ago matches calendar periods even when an intermediate month is missing", () => {
  const points = Array.from({ length: 25 }, (_, index) => ({
    date: new Date(Date.UTC(2024, 6 + index, 1)).toISOString().slice(0, 10),
    value: index,
  })).filter((point) => point.date !== "2025-10-01");
  const view = projectStat({ stat: findStat("cpi-yoy"), points, trend: fitTrend(points) }, "5Y");
  expect(view.latest.date).toBe("2026-07-01");
  expect(view.yearAgo).toEqual({ date: "2025-07-01", value: 12 });
  const missingBase = points.filter((point) => point.date !== "2025-07-01");
  expect(projectStat({ stat: findStat("cpi-yoy"), points: missingBase, trend: fitTrend(missingBase) }, "5Y").yearAgo).toBeNull();
});
