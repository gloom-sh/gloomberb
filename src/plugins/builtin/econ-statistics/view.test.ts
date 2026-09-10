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


test("daily 1Y ago clamps February 29 to February 28 instead of looking forward into March", () => {
  const points = [
    { date: "2023-02-27", value: 4.1 }, { date: "2023-02-28", value: 4.2 },
    { date: "2023-03-01", value: 4.3 }, { date: "2024-02-28", value: 4.4 },
    { date: "2024-02-29", value: 4.5 },
  ];
  const view = projectStat({ stat: findStat("ten-year"), points, trend: fitTrend(points) }, "5Y");
  expect(view.yearAgo).toEqual({ date: "2023-02-28", value: 4.2 });
});
