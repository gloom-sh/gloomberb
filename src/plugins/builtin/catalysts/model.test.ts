import { enrollmentSeries } from "./history";
import { describe, expect, test } from "bun:test";
import { catalystFixture, catalystPayload } from "./test-fixture";
import { catalystBasisWidth, catalystCell, catalystChangeText, catalystColumns, catalystDate, catalystDateBasis, catalystEmptyTitle, catalystParties, catalystQuery, catalystSection, catalystSections, catalystStatusTone } from "./model";
import { validateCatalystDetail, validateCatalysts } from "./client";
import { catalystMatches } from "../alerts/catalysts";
import { createEventAlert, readEventAlerts } from "../alerts/events";

const event = catalystFixture;

test("party revision summaries expose changed links and preserve additions, removals and nonnumeric values", () => {
  const unchanged = { name: "Research hospital", role: "collaborator", ticker: null, exchange: null, entityId: null, confidence: 0, resolution: "unresolved" };
  const old = { ...unchanged, name: "AstraZeneca", role: "lead sponsor" };
  const linked = { ...old, ticker: "AZN", exchange: "NYSE", entityId: "56", confidence: 0.95, resolution: "alias" };
  const text = catalystChangeText({ field: "parties", before: [unchanged, old], after: [unchanged, linked] });
  expect(text).toBe("Unlinked → AZN:XNYS (95%): AstraZeneca (lead sponsor)");
  expect(catalystChangeText({ field: "parties", before: [linked], after: [] })).toContain("removed, AZN:XNYS (95%)");
  expect(catalystChangeText({ field: "parties", before: [], after: [old] })).toContain("added, Unlinked");
  expect(catalystChangeText({ field: "parties", before: [linked], after: [{ ...linked, entityId: "57" }] })).toContain("Link evidence updated");
  expect(catalystChangeText({ field: "metadata.enrollment", before: null, after: 0 })).toBe("Enrollment: -- → 0");
  expect(catalystChangeText({ field: "metadata.hasResults", before: false, after: true })).toBe("Has results: No → Yes");
  expect(catalystChangeText({ field: "metadata.phases", before: [], after: ["PHASE1", "PHASE2"] })).toBe("Phases: None → PHASE1, PHASE2");
});

describe("catalyst parties, tones and columns", () => {
  test("names the linked party first, reads a Federal Register filer from the title, and keeps the rest as the event", () => {
    const party = (name: string, ticker: string | null) => ({ ...event.parties[0]!, name, ticker });
    expect(catalystParties({ ...event, parties: [party("Vertex Pharmaceuticals Incorporated", null), party("Moderna, Inc", "MRNA")] })).toBe("Moderna +1");
    const sro = { ...event, parties: [], title: "Self-Regulatory Organizations; Cboe EDGA Exchange, Inc.; Notice of Filing of a Proposed Rule Change" };
    expect(catalystParties(sro)).toBe("Cboe EDGA Exchange");
    expect(catalystCell(sro, "title", "any", false)).toBe("Notice of Filing of a Proposed Rule Change");
    const filer = { ...event, parties: [], title: "Dominion Energy South Carolina, Inc.; Notice of Application" };
    expect(catalystParties(filer)).toBe("Dominion Energy South Carolina");
    // An agency heading is not a filer, and the title stays whole.
    const heading = { ...event, parties: [], title: "Airworthiness Directives; Airbus Helicopters" };
    expect(catalystParties(heading)).toBe("--");
    expect(catalystCell(heading, "title", "any", false)).toBe(heading.title);
  });
  test("tones a status by what it means for the company", () => {
    expect(catalystStatusTone("complete response letter")).toBe("negative");
    expect(catalystStatusTone("NO_LONGER_AVAILABLE")).toBe("negative");
    expect(catalystStatusTone("early termination granted")).toBe("positive");
    expect(catalystStatusTone("approved_for_marketing")).toBe("positive");
    expect(catalystStatusTone("settled action filed; court approval pending")).toBe("warning");
    expect(catalystStatusTone("ACTIVE_NOT_RECRUITING")).toBe("accent");
    expect(catalystStatusTone("Notice")).toBe("muted");
    expect(catalystStatusTone("company-reported target")).toBe("text");
  });
  test("keeps date, ticker, parties, event and status at 80 columns and fits the table to the width", () => {
    const need = (width: number) => catalystColumns(width, false, false).reduce((sum, column) => sum + column.width + 1, 3);
    expect(catalystColumns(78, false, false).map((column) => column.id)).toEqual(["date", "ticker", "parties", "title", "status"]);
    for (const width of [78, 110, 158]) expect(need(width)).toBeLessThanOrEqual(width);
    expect(catalystColumns(158, false, false).map((column) => column.id)).toEqual(["date", "basis", "ticker", "parties", "title", "type", "status", "agency", "country"]);
  });
});

describe("catalyst provenance and dates", () => {
  test("preserves month precision without inventing a day and distinguishes observed time", () => {
    expect(catalystDate(event)).toBe("2027-04");
    expect(catalystDate(event, "announced")).toBe("2026-01-01");
    expect(catalystDate(event, "effective")).toBe("--");
    expect(catalystDate(event, "observed")).toBe("2026-10-04 12:00");
    expect(catalystQuery({ tab: "changes", upcoming: true, country: "EU" }, "NOVN:SIX")).toEqual({ symbol: "NOVN:SIX", country: "EU", changed: true, dateField: "observed" });
  });
  // VKTX's NCT07846033 read "Completion" for the sponsor's estimated primary completion.
  test("a trial's date says primary completion, estimated or actual, as the registry types it", () => {
    const trial = (type?: string) => ({ ...event, metadata: { deadlineMeaning: "Primary completion date, actual or estimated as reported by sponsor",
      ...type ? { primaryCompletion: { date: "2027-04", type } } : {} } });
    expect(catalystDateBasis(trial("ESTIMATED"))).toBe("Primary completion (est.)");
    expect(catalystDateBasis(trial("ACTUAL"))).toBe("Primary completion (actual)");
    expect(catalystDateBasis(trial())).toBe("Primary completion");
    // The column widens to the longest label on screen, and gives up only what a narrow pane lacks.
    expect(catalystBasisWidth([event], "any")).toBe(10);
    expect(catalystBasisWidth([event, trial("ACTUAL")], "any")).toBe(27);
    const basis = (width: number) => catalystColumns(width, false, false, 27).find((column) => column.id === "basis")?.width;
    expect(basis(158)).toBe(27);
    expect(basis(130)).toBe(26);
    expect(basis(110)).toBe(10);
  });
  // CRMD's PDUFA without its day was dated by the 8-K that mentioned it.
  test("a withheld date reads as not disclosed, never as the announcement", () => {
    const withheld = { ...event, type: "pdufa" as const, deadlineDate: null, datePrecision: { announced: "day" as const }, announcedDate: "2026-10-19",
      metadata: { dateWithheld: true, deadlineMeaning: "Company-reported FDA PDUFA target date" } };
    expect(catalystDate(withheld)).toBe("--");
    expect(catalystDateBasis(withheld)).toBe("Date not disclosed");
    expect(catalystSection(withheld, "any", false)).toBe("Date not disclosed");
    expect(catalystDate(withheld, "announced")).toBe("2026-10-19");
    expect(catalystDateBasis(withheld, "announced")).toBe("Announced");
  });
  // The server sends upcoming dates first, then past ones; grouping by month kept a past day ahead of later months.
  test("sections keep the server's order, heading a month today splits twice", () => {
    const on = (id: string, deadlineDate: string) => ({ ...event, id, deadlineDate });
    const rows = [on("a", "2026-10-24"), on("b", "2029-03-31"), on("c", "2026-10-02"), on("d", "2026-09-23"), on("e", "2026-09-01")];
    expect(catalystSections(rows, "any", false).map((section) => [section.key, section.label, section.items.map((item) => item.id).join("")])).toEqual([
      ["October 2026", "October 2026", "a"],
      ["March 2029", "March 2029", "b"],
      ["October 2026:1", "October 2026", "c"],
      ["September 2026", "September 2026", "de"],
    ]);
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

test("an empty litigation list says nothing is linked, and which court dockets are not collected, unless a filter emptied it", () => {
  const courts = { ...catalystPayload(), coverage: { ...catalystPayload().coverage, totalEvents: 19_113, sources: [
    { id: "courtlistener", name: "CourtListener court dockets", agency: "US courts", jurisdiction: "US", country: "US", enabled: false, homepage: "https://example.com", cadenceMinutes: 60, coverage: "", state: null, events: 0 },
  ] } };
  const query = catalystQuery({}, "MSFT", true);
  expect(catalystEmptyTitle(courts, query, false)).toBe("No cases linked to MSFT. US court dockets are not collected yet, so only agency and regulator actions show.");
  expect(catalystEmptyTitle(courts, catalystQuery({ search: "antitrust" }, "MSFT", true), false)).toBe("No events match these filters.");
  expect(catalystEmptyTitle(courts, catalystQuery({}, "PFE"), false)).toBe("No events linked to PFE yet.");
});
