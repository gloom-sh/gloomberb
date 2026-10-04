import { expect, test } from "bun:test";
import { attentionRows, historyPoints } from "./model";
import { attentionFixture } from "./test-fixture";
test("abnormal rankings require a baseline and keep absent values last in either direction", () => {
  const data = attentionFixture();
  expect(attentionRows(data.rows, "abnormal", "", "zScore", "desc")).toHaveLength(5);
  expect(attentionRows(data.rows, "ranking", "", "zScore", "asc").at(-1)?.zScore).toBeNull();
  expect(attentionRows(data.rows, "ranking", "jpx", "rank", "asc").map((row) => row.symbol)).toEqual(["6758:JPX", "7203:JPX"]);
});
test("suppressed or missing hours break the plot without becoming zero", () => {
  const points = historyPoints([{ bucketStart: "2026-10-01T00:00:00Z", researchUnits: 20 }, { bucketStart: "2026-10-01T03:00:00Z", researchUnits: 30 }]);
  expect(points.map((point) => point.value)).toEqual([20, null, null, 30]);
});
