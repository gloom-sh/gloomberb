import { expect, test } from "bun:test";
import { predictionHistoryPoints } from "./capability";

test("prediction chart history restores persisted dates, drops invalid rows, and sorts observations", () => {
  const points = predictionHistoryPoints([
    { date: "2026-02-02T00:00:00Z" as unknown as Date, close: 0.6 },
    { date: new Date("invalid"), close: 0.9 },
    { date: "2026-02-01T00:00:00Z" as unknown as Date, close: 0.4, open: 0.3 },
  ], "polymarket");

  expect(points.map((point) => [point.date.toISOString(), point.value])).toEqual([
    ["2026-02-01T00:00:00.000Z", 0.4],
    ["2026-02-02T00:00:00.000Z", 0.6],
  ]);
  expect(points[0]).toMatchObject({ open: 0.3, provenance: { providerId: "polymarket", quality: "reported" } });
});
