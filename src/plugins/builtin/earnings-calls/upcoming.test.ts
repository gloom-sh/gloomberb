import { describe, expect, test } from "bun:test";
import type { CloudEarningsCallPayload } from "../../../api-client";
import { buildSectionedRows } from "../../../components";
import { calendarAway, callStatusLabel } from "./data";
import { nextCallNotice } from "./headless";
import {
  calendarDays,
  calendarSections,
  callCountdown,
  callDay,
  callStartText,
  callTimeKnown,
  compareCallStarts,
  isUpcomingCall,
  nextCall,
} from "./upcoming";

// Wednesday Oct 21 2026, 14:00 in New York (EDT, UTC-4).
const NOW = Date.parse("2026-10-21T18:00:00Z");

const call = (id: string, callAt: string | null, extra: Partial<CloudEarningsCallPayload> = {}): CloudEarningsCallPayload => ({
  id, ticker: id.split("-")[0]!.toUpperCase(), companyName: null, fiscalYear: 2026, fiscalQuarter: 3,
  callAt, status: "discovered", durationSeconds: null, wordCount: null, hasTranscript: false, sentiment: null,
  ...extra,
});

describe("a call's start", () => {
  test("midnight UTC is a day alone, unless the server says the time is known", () => {
    // META at 16:30 New York; IBM known by its day alone; a call at midnight UTC that the server says starts then.
    expect(callTimeKnown(call("meta", "2026-10-21T20:30:00Z"))).toBe(true);
    expect(callTimeKnown(call("ibm", "2026-10-22T00:00:00Z"))).toBe(false);
    expect(callTimeKnown(call("sony", "2026-10-22T00:00:00Z", { callTimeKnown: true }))).toBe(true);
    expect(callTimeKnown(call("odd", "2026-10-22T13:00:00Z", { callTimeKnown: false }))).toBe(false);
    // A day alone is that UTC date; an evening start in New York is still that New York day.
    expect(callDay(call("ibm", "2026-10-22T00:00:00Z"))).toBe("2026-10-22");
    expect(callDay(call("late", "2026-10-22T01:30:00Z"))).toBe("2026-10-21");
    expect(callDay(call("sony", "2026-10-22T00:00:00Z", { callTimeKnown: true }))).toBe("2026-10-21");
  });

  test("a call is upcoming until it starts; a day alone until that New York day ends; a transcript ends it", () => {
    expect(isUpcomingCall(call("meta", "2026-10-21T20:30:00Z"), NOW)).toBe(true);
    expect(isUpcomingCall(call("early", "2026-10-21T12:30:00Z"), NOW)).toBe(false);
    expect(isUpcomingCall(call("today", "2026-10-21T00:00:00Z"), NOW)).toBe(true);
    expect(isUpcomingCall(call("yesterday", "2026-10-20T00:00:00Z"), NOW)).toBe(false);
    expect(isUpcomingCall(call("done", "2026-10-22T20:30:00Z", { hasTranscript: true, status: "published" }), NOW)).toBe(false);
    expect(isUpcomingCall(call("none", null), NOW)).toBe(false);
  });
});

describe("the next call", () => {
  test("is the soonest still to come, timed calls ahead of a day alone on the same day", () => {
    const calls = [
      call("aapl-past", "2026-07-30T21:00:00Z", { hasTranscript: true, status: "published" }),
      call("aapl-later", "2027-01-28T21:30:00Z"),
      call("aapl-day", "2026-10-29T00:00:00Z"),
      call("aapl-next", "2026-10-29T20:30:00Z"),
    ];
    expect(nextCall(calls, NOW)?.id).toBe("aapl-next");
    expect([...calls].sort(compareCallStarts).map((item) => item.id)).toEqual(["aapl-past", "aapl-next", "aapl-day", "aapl-later"]);
    expect(nextCall(calls.slice(0, 1), NOW)).toBeNull();
  });

  test("is labelled upcoming, never queued, and counts down", () => {
    const meta = call("meta", "2026-10-21T20:30:00Z");
    expect(callStatusLabel(meta, NOW)).toBe("upcoming");
    expect(callStatusLabel(call("past", "2026-10-01T20:30:00Z"), NOW)).toBe("queued");
    expect(callCountdown(meta, NOW)).toBe("in 2h 30m");
    expect(callCountdown(meta, Date.parse("2026-10-21T20:29:30Z"))).toBe("in <1m");
    expect(callCountdown(meta, Date.parse("2026-10-21T20:31:00Z"))).toBe("started");
    expect(callCountdown(call("ibm", "2026-10-21T00:00:00Z"), NOW)).toBe("today");
    expect(callCountdown(call("ibm", "2026-10-22T00:00:00Z"), NOW)).toBe("tomorrow");
    expect(callCountdown(call("ibm", "2026-10-23T00:00:00Z"), NOW)).toBe("Fri");
    expect(callCountdown(call("ibm", "2026-11-05T00:00:00Z"), NOW)).toBe("Nov 5");
  });

  test("names its start here and in New York, or New York's alone when the clocks agree", () => {
    const meta = call("meta", "2026-10-21T20:30:00Z");
    const { start, newYork } = callStartText(meta, NOW);
    const here = new Date(Date.parse(meta.callAt!));
    const sameClock = here.getHours() === 16 && here.getMinutes() === 30 && here.getDate() === 21;
    if (sameClock) {
      expect(start).toBe("Wed Oct 21 16:30 ET");
      expect(newYork).toBeNull();
    } else {
      expect(start).toMatch(/^\w{3} \w{3} \d{1,2} \d{2}:\d{2}$/);
      expect(newYork).toBe("16:30 ET");
    }
    expect(callStartText(call("ibm", "2026-10-22T00:00:00Z"), NOW)).toEqual({ start: "Thu Oct 22", newYork: null });
    // The notice says the countdown within a day, not a weekday it already names.
    expect(nextCallNotice(meta, NOW)).toMatch(/^Next call .*16:30.*, in 2h 30m\.$/);
    expect(nextCallNotice(call("ibm", "2026-10-23T00:00:00Z"), NOW)).toBe("Next call Fri Oct 23.");
  });
});

describe("the calendar", () => {
  const days = calendarDays(NOW);

  test("is today, the next session and the rest of the week", () => {
    expect(days.map((day) => [day.label, day.from, day.to])).toEqual([
      ["Today", "2026-10-21", "2026-10-21"],
      ["Tomorrow", "2026-10-22", "2026-10-22"],
      ["Rest of week", "2026-10-23", "2026-10-23"],
    ]);
  });

  test("puts each call on its New York day in start order, once, and leaves days without calls out", () => {
    const calls = [
      call("ibm-day", "2026-10-22T00:00:00Z"),
      call("meta-1", "2026-10-21T20:30:00Z"),
      // The twin a second source stored for the same call.
      call("meta-2", "2026-10-21T20:30:00Z", { ticker: "META", status: "available" }),
      call("tsla", "2026-10-21T21:30:00Z"),
      call("ko", "2026-10-21T12:30:00Z"),
      call("now-late", "2026-10-22T01:00:00Z"),
      call("aal", "2026-10-22T12:30:00Z"),
      call("next", "2026-10-28T20:00:00Z"),
    ];
    const sections = calendarSections(calls, days);
    expect(sections.map((section) => [section.label, section.items.map((item) => item.id)])).toEqual([
      ["Today", ["ko", "meta-1", "tsla", "now-late"]],
      ["Tomorrow", ["aal", "ibm-day"]],
      ["Rest of week", []],
    ]);
    const rows = buildSectionedRows(sections, (item) => item.id);
    expect(rows.filter((row) => row.kind === "section").map((row) => row.kind === "section" && `${row.label} (${row.count})`))
      .toEqual(["Today (4)", "Tomorrow (2)"]);
    expect(calendarSections(calls, days, { column: "ticker", direction: "desc" })[0]!.items.map((item) => item.ticker))
      .toEqual(["TSLA", "NOW", "META", "KO"]);
  });

  test("says how far away a call is, and for one over, where its transcript is", () => {
    expect(calendarAway(call("meta", "2026-10-21T20:30:00Z"), NOW)).toBe("in 2h 30m");
    expect(calendarAway(call("ko", "2026-10-21T16:30:00Z"), NOW)).toBe("started");
    expect(calendarAway(call("ko", "2026-10-21T12:30:00Z"), NOW)).toBe("queued");
    expect(calendarAway(call("ko", "2026-10-21T16:30:00Z", { status: "capturing" }), NOW)).toBe("in progress");
    expect(calendarAway(call("ko", "2026-10-21T12:30:00Z", { hasTranscript: true, status: "published" }), NOW)).toBe("transcribed");
  });
});
