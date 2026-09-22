import { expect, test } from "bun:test";
import { buildTrailChart } from "./trail-chart-model";

test("scatter trails preserve backtracking and vertical edges without changing symmetric domains", () => {
  const chart = buildTrailChart(
    [
      {
        id: "loop",
        label: "Loop",
        color: "#ff0000",
        points: [
          { x: 101, y: 101, date: "2026-01-02" },
          { x: 99, y: 102, date: "2026-01-09" },
          { x: 99, y: 98, date: "2026-01-16" },
          { x: 102, y: 99, date: "2026-01-23" },
        ],
      },
    ],
    100,
    "#888888",
  );
  const edges = chart.series.filter((series) => series.id.includes(":edge:"));
  expect(edges).toHaveLength(3);
  expect(edges[0]!.points.map((point) => point.value)).toEqual([102, 101]);
  expect(
    edges[1]!.points[1]!.date.getTime() - edges[1]!.points[0]!.date.getTime(),
  ).toBe(1);
  expect((chart.min + chart.max) / 2).toBe(100);
  expect(chart.series.at(-1)!.points[0]!.value).toBe(99);
});
