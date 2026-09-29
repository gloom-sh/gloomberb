import { afterEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import type { EconEvent } from "./types";
import {
  attachEconCalendarPersistence,
  calendarDisplayRows,
  loadCalendar,
  matchesCountry,
  matchesImpact,
  resetEconCalendarPersistence,
} from "./calendar-model";

function makeEvent(id: string): EconEvent {
  return {
    id,
    date: new Date("2026-05-24T13:30:00.000Z"),
    time: "08:30",
    country: "US",
    event: "Core PCE Price Index",
    impact: "high",
    actual: null,
    forecast: "0.3%",
    prior: "0.2%",
  };
}

afterEach(() => {
  resetEconCalendarPersistence();
});

describe("econ calendar cache", () => {
  test("rehydrates persisted events without refetching", async () => {
    const persistence = new MemoryPluginPersistence();
    attachEconCalendarPersistence(persistence);

    await loadCalendar(false, async () => [makeEvent("pce")]);

    resetEconCalendarPersistence();
    attachEconCalendarPersistence(persistence);

    let calls = 0;
    const result = await loadCalendar(false, async () => {
      calls += 1;
      return [makeEvent("fallback")];
    });

    expect(calls).toBe(0);
    expect(result.data.map((event) => event.id)).toEqual(["pce"]);
    expect(result.data[0]!.date).toBeInstanceOf(Date);
    expect(result.stale).toBe(false);
  });

  test("marks a failed refresh stale instead of passing the cache off as fresh", async () => {
    const persistence = new MemoryPluginPersistence();
    attachEconCalendarPersistence(persistence);
    await loadCalendar(false, async () => [makeEvent("pce")]);

    const result = await loadCalendar(true, async () => {
      throw new Error("calendar endpoint down");
    });

    expect(result.data.map((event) => event.id)).toEqual(["pce"]);
    expect(result.stale).toBe(true);
    expect(result.refreshError).toContain("calendar endpoint down");
  });
});

describe("econ calendar filters", () => {
  test("each impact level selects only its own events", () => {
    const low = { ...makeEvent("low"), impact: "low" as const };
    const high = makeEvent("high");
    expect(matchesImpact(low, "low")).toBe(true);
    expect(matchesImpact(high, "low")).toBe(false);
    expect(matchesImpact(high, "all")).toBe(true);
  });

  test("G7 covers every member, not just the ones with a cached flag", () => {
    for (const country of ["US", "GB", "FR", "DE", "IT", "JP", "CA", "EU"]) {
      expect(matchesCountry({ ...makeEvent(country), country }, "G7")).toBe(true);
    }
    expect(matchesCountry({ ...makeEvent("cn"), country: "CN" }, "G7")).toBe(false);
  });
});

describe("calendar rows", () => {
  const at = (id: string, day: number, hour: number): EconEvent => ({ ...makeEvent(id), date: new Date(2026, 8, day, hour) });
  const layout = (events: EconEvent[], now: Date) => calendarDisplayRows(events, now.getTime())
    .map((row) => row.kind === "event" ? row.event.id : row.kind === "now" ? "NOW" : row.label.split(" · ")[0]);

  test("reads forward in time with NOW under today's header before the next release", () => {
    const events = [at("mon-9", 28, 9), at("mon-16", 28, 16), at("tue-1", 29, 1)];
    expect(layout(events, new Date(2026, 8, 28, 12))).toEqual(["TODAY", "mon-9", "NOW", "mon-16", "TOMORROW", "tue-1"]);
  });

  test("puts NOW above the next day's header when nothing is left today", () => {
    const events = [at("mon-9", 28, 9), at("mon-16", 28, 16), at("tue-1", 29, 1)];
    expect(layout(events, new Date(2026, 8, 28, 20))).toEqual(["TODAY", "mon-9", "mon-16", "NOW", "TOMORROW", "tue-1"]);
  });
});
