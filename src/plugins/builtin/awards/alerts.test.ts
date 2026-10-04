import { expect, test } from "bun:test";
import { newAwardAlerts } from "./alerts";
import { awardRow, awardsPayload } from "./test-fixture";

test("notifications baseline initial history, deduplicate revisions, suppress backfills and cap remembered IDs", () => {
  const baseline = newAwardAlerts(awardsPayload(), null, "scope");
  expect(baseline.fresh).toEqual([]);
  const current = awardsPayload({ generatedAt: "2026-10-04T13:00:00Z", alerts: [
    awardRow({ id: "new", awardDate: "2026-10-03", observedAt: "2026-10-04T12:30:00Z" }),
    awardRow({ id: "old", awardDate: "2024-10-03", observedAt: "2026-10-04T12:30:00Z" }), awardRow(),
  ] });
  const next = newAwardAlerts(current, baseline.state, "scope");
  expect(next.fresh.map((row) => row.id)).toEqual(["new"]);
  expect(newAwardAlerts(current, next.state, "scope").fresh).toEqual([]);
  expect(newAwardAlerts(current, next.state, "different").fresh).toEqual([]);
  const large = awardsPayload({ alerts: Array.from({ length: 700 }, (_, index) => awardRow({ id: String(index) })) });
  expect(newAwardAlerts(large, null, "scope").state.seen).toHaveLength(500);
});
