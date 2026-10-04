import { enrollmentSeries } from "./history";
import { describe, expect, test } from "bun:test";
import { catalystFixture } from "./test-fixture";
import { catalystDate, catalystQuery } from "./model";
import { validateCatalystDetail, validateCatalysts } from "./client";
import { catalystMatches } from "../alerts/catalysts";
import { createEventAlert, readEventAlerts } from "../alerts/events";

const event = catalystFixture;

describe("catalyst provenance and dates", () => {
  test("preserves month precision without inventing a day and distinguishes observed time", () => {
    expect(catalystDate(event)).toBe("2027-04");
    expect(catalystDate(event, "announced")).toBe("2026-01-01");
    expect(catalystDate(event, "effective")).toBe("--");
    expect(catalystDate(event, "observed")).toBe("2026-10-04 12:00");
    expect(catalystQuery({ tab: "changes", upcoming: true, country: "EU" }, "NOVN:SIX")).toEqual({ symbol: "NOVN:SIX", country: "EU", changed: true, dateField: "observed" });
  });
  test("rejects cross-event history, duplicate event IDs and unsafe document URLs", () => {
    expect(() => validateCatalystDetail({ event, history: [{ ...event, id: "other" }], asOf: event.observedAt })).toThrow("invalid event history");
    expect(() => validateCatalystDetail({ event: { ...event, sourceUrl: "javascript:alert(1)" }, history: [], asOf: event.observedAt })).toThrow();
    const payload = { events: [event, event], total: 2, limit: 100, offset: 0, facets: {}, asOf: event.observedAt };
    expect(() => validateCatalysts(payload as never)).toThrow("invalid catalyst events");
  });
});
describe("catalyst alert targets", () => {
  test("round trips target rules and excludes older observations and paused rules", () => {
    const rule = createEventAlert("catalyst-ticker", "PFE", Date.parse("2026-10-03"));
    expect(readEventAlerts(JSON.stringify([rule])).rules).toEqual([rule]);
    expect(catalystMatches(rule, event, new Set())).toBe(true);
    expect(catalystMatches({ ...rule, status: "paused" }, event, new Set())).toBe(false);
    expect(catalystMatches({ ...rule, createdAt: Date.parse("2026-10-05") }, event, new Set())).toBe(false);
    expect(catalystMatches(createEventAlert("catalyst-watched", "", rule.createdAt), event, new Set(["PFE:XNYS"]))).toBe(true);
    expect(catalystMatches(createEventAlert("catalyst-country", "GB", rule.createdAt), event, new Set())).toBe(false);
    expect(() => createEventAlert("catalyst-type", "invented")).toThrow();
  });
});

test("enrollment history uses observation times, keeps missing counts as gaps and separates estimated from actual", () => {
  const colors = { textBright: "#ffffff", warning: "#ffcc00", positive: "#00ff00" };
  const first = { ...event, metadata: { enrollment: 200, enrollmentType: "ESTIMATED" } };
  expect(enrollmentSeries([first], colors)).toEqual([]);
  const next = { ...first, revisionId: "101", revision: 3, observedAt: "2026-10-05T12:00:00Z", metadata: { enrollment: 190, enrollmentType: "ACTUAL" } };
  const missing = { ...next, revisionId: "102", revision: 4, observedAt: "2026-10-06T12:00:00Z", metadata: {} };
  const series = enrollmentSeries([missing, next, first], colors);
  expect(series.map((entry) => entry.points.map((point) => point.value))).toEqual([[200, null, null], [null, 190, null]]);
  expect(series[0]!.points[0]!.date.toISOString()).toBe(first.observedAt);
  expect(series[0]!.unit).toBe("participants");
});
