import { expect, test } from "bun:test";
import { lastSessionNote, parseTapeClock, servedWindow, tapePageEnd, tapeWindowRange } from "./window";

const closed = (date: string) => servedWindow({ session: { date, high: null, low: null, asOf: null }, generatedAt: "2026-12-07T10:00:00.000Z", delaySeconds: 900 })!;

test("Sunday at 14:00 New York labels Friday as the last session without labelling Monday premarket prints as Friday", () => {
  const snapshot = { session: { date: "2026-11-13", high: 102, low: 98, asOf: "2026-11-13T21:00:00Z" },
    generatedAt: "2026-11-15T19:00:00Z", delaySeconds: 900 as const, asOf: "2026-11-13T20:59:59Z" };
  expect(lastSessionNote(snapshot)).toBe("Market closed; last session Fri 13 Nov 2026.");
  expect(servedWindow(snapshot)?.date).toBe("2026-11-13");
  expect(lastSessionNote({ ...snapshot, generatedAt: "2026-11-16T15:00:00Z" })).toBe("Last available session Fri 13 Nov 2026.");
  expect(lastSessionNote({ ...snapshot, generatedAt: "2026-11-16T14:00:00Z", asOf: "2026-11-16T13:44:59Z" })).toBeNull();
});

test("a window's times are New York's clock on the served session's date, through either daylight-saving offset, or UTC's when marked", () => {
  const october = closed("2026-10-16");
  expect(tapeWindowRange(october, parseTapeClock("10:30"), parseTapeClock("10:35"))).toEqual({ from: "2026-10-16T14:30:00.000Z", to: "2026-10-16T14:35:00.000Z" });
  // EST: five hours behind UTC.
  expect(tapeWindowRange(closed("2026-12-04"), parseTapeClock("10:30:15"), null))
    .toEqual({ from: "2026-12-04T15:30:15.000Z", to: "2026-12-05T01:00:00.000Z" });
  expect(tapeWindowRange(october, parseTapeClock("14:30Z"), parseTapeClock("14:31 UTC"))).toEqual({ from: "2026-10-16T14:30:00.000Z", to: "2026-10-16T14:31:00.000Z" });
  // Without --from the window opens with the SIP day at 04:00 New York.
  expect(tapeWindowRange(october, null, parseTapeClock("4:01")).from).toBe("2026-10-16T08:00:00.000Z");
  expect(() => parseTapeClock("25:00")).toThrow("25:00 is not a time: use 10:30 or 10:30:15 (New York time), 14:30Z (UTC), or 2026-11-20T14:30:00Z.");
  expect(() => parseTapeClock("10.30")).toThrow("not a time");
});

test("a timestamp is its own instant: on the served session it bounds the window, on another day it says the depth and where that day is", () => {
  const october = closed("2026-10-16");
  expect(tapeWindowRange(october, parseTapeClock("2026-10-16T14:30:00Z"), parseTapeClock("2026-10-16 10:35"))).toEqual({
    from: "2026-10-16T14:30:00.000Z", to: "2026-10-16T14:35:00.000Z",
  });
  // To the nanosecond it names: a print's own stamp, read on from, is the window's start, not its millisecond or second.
  expect(tapeWindowRange(october, parseTapeClock("2026-10-16T10:30:00.250-04:00"), null).from).toBe("2026-10-16T14:30:00.250Z");
  expect(tapeWindowRange(october, parseTapeClock("2026-10-16T14:30:00.392451123Z"), parseTapeClock("10:30:00.392451124")))
    .toEqual({ from: "2026-10-16T14:30:00.392451123Z", to: "2026-10-16T14:30:00.392451124Z" });
  expect(() => tapeWindowRange(october, parseTapeClock("2026-10-16T14:30:00.392451123Z"), parseTapeClock("2026-10-16T14:30:00.392451123Z")))
    .toThrow("must be after --from");
  // 00:30 UTC on the 17th is 20:30 the evening before in New York: the served session's day, past its end.
  expect(() => tapeWindowRange(october, parseTapeClock("2026-10-17T00:30:00Z"), null)).toThrow("is outside the window TAS serves");
  expect(() => tapeWindowRange(october, parseTapeClock("2026-07-24T13:30:00Z"), null, "FFAI")).toThrow(
    "TAS serves the latest session only, Fri 16 Oct 2026; Fri 24 Jul 2026 is not on it. That day's 1-minute bars: fn GIP FFAI --session 2026-07-24 --chart-resolution 1m.");
  expect(() => parseTapeClock("2026-02-30T10:00:00Z")).toThrow("not a time");
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

test("a full page ends before the stamp its last prints share, and the next reads from that stamp", () => {
  const row = (timestamp: string) => ({ timestamp });
  const page = [row("2026-10-16T14:30:00.100Z"), row("2026-10-16T14:30:00.392451123Z"), row("2026-10-16T14:30:00.392451123Z")];
  expect(tapePageEnd(page)).toEqual({ rows: page.slice(0, 1), next: "2026-10-16T14:30:00.392451123Z" });
  // A page all at one stamp keeps its prints and reads on from the nanosecond after, across a second's end too.
  expect(tapePageEnd([row("2026-10-16T14:30:00.999999999Z"), row("2026-10-16T14:30:00.999999999Z")]).next).toBe("2026-10-16T14:30:01.000000000Z");
  expect(tapePageEnd([])).toEqual({ rows: [], next: null });
});
