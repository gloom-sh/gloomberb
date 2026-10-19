import { expect, test } from "bun:test";
import { parseTapeClock, servedWindow, tapeWindowRange } from "./window";

const closed = (date: string) => servedWindow({ session: { date, high: null, low: null, asOf: null }, generatedAt: "2026-12-07T10:00:00.000Z", delaySeconds: 900 })!;

test("a window's times are New York's clock on the served session's date, through either daylight-saving offset, or UTC's when marked", () => {
  const october = closed("2026-10-16");
  expect(tapeWindowRange(october, parseTapeClock("10:30"), parseTapeClock("10:35"))).toEqual({ from: "2026-10-16T14:30:00.000Z", to: "2026-10-16T14:35:00.000Z" });
  // EST: five hours behind UTC.
  expect(tapeWindowRange(closed("2026-12-04"), parseTapeClock("10:30:15"), null))
    .toEqual({ from: "2026-12-04T15:30:15.000Z", to: "2026-12-05T01:00:00.000Z" });
  expect(tapeWindowRange(october, parseTapeClock("14:30Z"), parseTapeClock("14:31 UTC"))).toEqual({ from: "2026-10-16T14:30:00.000Z", to: "2026-10-16T14:31:00.000Z" });
  // Without --from the window opens with the SIP day at 04:00 New York.
  expect(tapeWindowRange(october, null, parseTapeClock("4:01")).from).toBe("2026-10-16T08:00:00.000Z");
  expect(() => parseTapeClock("25:00")).toThrow("25:00 is not a time of day: use 10:30 or 10:30:15 (New York time), or 14:30Z (UTC).");
  expect(() => parseTapeClock("10.30")).toThrow("not a time of day");
});

test("a bound outside the served window is refused with the window that is served, its end the feed cutoff while the session runs", () => {
  expect(() => tapeWindowRange(closed("2026-10-16"), parseTapeClock("03:00"), null))
    .toThrow("--from 03:00:00 ET (07:00:00 UTC) is outside the window TAS serves: Fri 16 Oct 2026, 04:00:00 ET (08:00:00 UTC) to 20:00:00 ET (00:00:00 UTC).");
  // 15 minutes delayed at 11:00 ET: the tape is served to 10:45.
  const running = servedWindow({ session: { date: "2026-10-16", high: null, low: null, asOf: null }, generatedAt: "2026-10-16T15:00:00.000Z", delaySeconds: 900 })!;
  expect(running).toMatchObject({ cutoff: true, delayMinutes: 15, to: Date.parse("2026-10-16T14:45:00.000Z") });
  expect(tapeWindowRange(running, parseTapeClock("10:30"), parseTapeClock("10:45"))).toEqual({ from: "2026-10-16T14:30:00.000Z", to: "2026-10-16T14:45:00.000Z" });
  expect(() => tapeWindowRange(running, parseTapeClock("10:50"), parseTapeClock("11:00"))).toThrow("--from 10:50:00 ET (14:50:00 UTC) and --to 11:00:00 ET (15:00:00 UTC) are outside the window TAS serves: "
    + "Fri 16 Oct 2026, 04:00:00 ET (08:00:00 UTC) to 10:45:00 ET (14:45:00 UTC), the feed cutoff (15 min delayed).");
  expect(() => tapeWindowRange(running, parseTapeClock("10:35"), parseTapeClock("10:30"))).toThrow("--to 10:30:00 ET (14:30:00 UTC) must be after --from 10:35:00 ET (14:35:00 UTC).");
  expect(servedWindow({ session: { date: null, high: null, low: null, asOf: null }, generatedAt: "2026-10-16T15:00:00.000Z", delaySeconds: 0 })).toBeNull();
});
