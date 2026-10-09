import { expect, test } from "bun:test";
import { isRegularSessionTime, latestRegularSessionClose, latestRegularSessionOpen, regularSessionCloseUtcMinute } from "./freshness";

const at = (iso: string) => Date.parse(iso);
const iso = (time: number | null | undefined) => (time == null ? null : new Date(time).toISOString());

test("TASE's Friday session closes at 13:50, the other weekdays at 17:30, whatever the clock offset", () => {
  // Summer time (UTC+3): Thursday 8 October and Friday 9 October.
  expect(iso(latestRegularSessionClose("TASE", at("2026-10-08T20:00:00Z"))?.close)).toBe("2026-10-08T14:30:00.000Z");
  expect(iso(latestRegularSessionClose("TASE", at("2026-10-09T20:00:00Z"))?.close)).toBe("2026-10-09T10:50:00.000Z");
  // Before Friday's close the latest one is still Thursday's, and over the weekend Friday's.
  expect(latestRegularSessionClose("TASE", at("2026-10-09T10:49:00Z"))?.date).toBe("2026-10-08");
  expect(latestRegularSessionClose("TASE", at("2026-10-11T12:00:00Z"))?.date).toBe("2026-10-09");
  // Winter time (UTC+2).
  expect(iso(latestRegularSessionClose("TASE", at("2026-12-04T20:00:00Z"))?.close)).toBe("2026-12-04T11:50:00.000Z");
  expect(regularSessionCloseUtcMinute("TASE", at("2026-12-04T20:00:00Z"))).toBe(11 * 60 + 50);
  expect(regularSessionCloseUtcMinute("TASE", at("2026-12-03T20:00:00Z"))).toBe(15 * 60 + 30);
  // Another venue keeps one close on Fridays.
  expect(iso(latestRegularSessionClose("EPA", at("2026-10-09T20:00:00Z"))?.close)).toBe("2026-10-09T15:40:00.000Z");
});

test("TASE's session state follows its Friday close", () => {
  // Friday opens at 09:59 (06:59Z) and ends at 10:50Z; Thursday ends at 14:30Z.
  expect(isRegularSessionTime("TASE", at("2026-10-09T06:58:00Z"))).toBe(false);
  expect(isRegularSessionTime("TASE", at("2026-10-09T06:59:00Z"))).toBe(true);
  expect(isRegularSessionTime("TASE", at("2026-10-09T10:49:00Z"))).toBe(true);
  expect(isRegularSessionTime("TASE", at("2026-10-09T10:50:00Z"))).toBe(false);
  expect(isRegularSessionTime("TASE", at("2026-10-08T14:29:00Z"))).toBe(true);
  expect(isRegularSessionTime("TASE", at("2026-10-08T14:30:00Z"))).toBe(false);
  // Over the weekend the latest open is still Friday's.
  expect(iso(latestRegularSessionOpen("TASE", at("2026-10-11T12:00:00Z")))).toBe("2026-10-09T06:59:00.000Z");
});
