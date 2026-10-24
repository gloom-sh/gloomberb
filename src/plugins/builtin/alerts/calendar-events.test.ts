import { expect, test } from "bun:test";
import type { EconEvent, EconImpact } from "../econ/types";
import {
  matchCalendarEvent,
  nextReleaseDate,
  releasePrintMessage,
  releaseReminderMessage,
  releaseRowOn,
} from "./calendar-events";

function row(date: string, country: string, impact: EconImpact, event: string, extra: Partial<EconEvent> = {}): EconEvent {
  return { id: `${country}-${event}-${date}`, date: new Date(date), time: date.slice(11, 16), country, event, impact,
    actual: null, forecast: null, prior: null, ...extra };
}

const NBS = { name: "National Bureau of Statistics" };
// China's week as the calendar lists it on Sat 24 Oct 2026, with the US and Canada beside it.
const calendar = [
  row("2026-10-14T01:30:00.000Z", "CN", "high", "Inflation Rate YoY", { actual: "0.4%", prior: "0.1%", source: NBS }),
  ...["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"].map((day) =>
    row(`${day}T00:00:00.000Z`, "CN", "medium", "Communist Party Fifth Plenum", { time: "All Day" })),
  row("2026-10-27T01:30:00.000Z", "CN", "low", "Industrial Profits (YTD) YoY", { prior: "15.7%", source: NBS }),
  row("2026-10-31T01:30:00.000Z", "CN", "medium", "NBS Non Manufacturing PMI", { prior: "50.2", source: NBS }),
  row("2026-10-31T01:30:00.000Z", "CN", "low", "NBS General PMI", { prior: "50.7", source: NBS }),
  row("2026-10-31T01:30:00.000Z", "CN", "high", "NBS Manufacturing PMI", { prior: "50.1", source: NBS }),
  row("2026-11-02T01:45:00.000Z", "CN", "high", "RatingDog Manufacturing PMI", { prior: "52.1" }),
  row("2026-11-02T14:00:00.000Z", "US", "high", "ISM Manufacturing PMI", { prior: "49.1" }),
  row("2026-11-06T13:30:00.000Z", "US", "high", "Non Farm Payrolls", { prior: "22K" }),
  row("2026-11-09T14:00:00.000Z", "CA", "medium", "Ivey PMI s.a", { prior: "52.6" }),
];
const now = Date.parse("2026-10-24T06:00:00Z");
const names = (choices: readonly { name: string; country: string }[]) => choices.map((choice) => `${choice.name} (${choice.country})`);

test("a release named by some of its words is the headline one, with the others it names beside it", () => {
  const nbs = matchCalendarEvent("NBS PMI", null, calendar, now);
  if (nbs.kind !== "match") throw new Error(nbs.kind);
  // Highest impact first, then the shortest name: the manufacturing PMI, not the general one.
  expect(nbs.choice).toMatchObject({ name: "NBS Manufacturing PMI", country: "CN", impact: "high", publisher: NBS.name });
  expect(nbs.choice.next?.date.toISOString()).toBe("2026-10-31T01:30:00.000Z");
  expect(names(nbs.others)).toEqual(["NBS Non Manufacturing PMI (CN)", "NBS General PMI (CN)"]);
  // A word's start and a name's initials read too, any case.
  for (const query of ["nbs manuf pmi", "Industrial Profits", "NFP"]) {
    expect(matchCalendarEvent(query, null, calendar, now).kind).toBe("match");
  }
  // CPI is China's Inflation Rate YoY, listed only in the past: no next date yet.
  const cpi = matchCalendarEvent("CPI", "CN", calendar, now);
  expect(cpi.kind === "match" && [cpi.choice.name, cpi.choice.next]).toEqual(["Inflation Rate YoY", null]);
});

test("a name in several countries asks which, and a country narrows it", () => {
  const pmi = matchCalendarEvent("PMI", null, calendar, now);
  expect(pmi.kind === "countries" && names(pmi.choices)).toEqual(["NBS Manufacturing PMI (CN)", "ISM Manufacturing PMI (US)", "Ivey PMI s.a (CA)"]);
  const china = matchCalendarEvent("PMI", "CN", calendar, now);
  expect(china.kind === "match" && china.choice.name).toBe("NBS Manufacturing PMI");
  // A region is a filter too; a name outside it is not found there.
  expect(matchCalendarEvent("ISM PMI", "G7", calendar, now).kind).toBe("match");
  expect(matchCalendarEvent("ISM PMI", "CN", calendar, now).kind).toBe("none");
});

test("nothing matching offers the nearest names: a slip in a word, or a name spelled close", () => {
  const slip = matchCalendarEvent("NBP PMI", null, calendar, now);
  expect(slip.kind === "none" && names(slip.suggestions)).toEqual(["NBS Manufacturing PMI (CN)", "NBS Non Manufacturing PMI (CN)", "NBS General PMI (CN)"]);
  const spelled = matchCalendarEvent("Industrail Proffits", "CN", calendar, now);
  expect(spelled.kind === "none" && names(spelled.suggestions)).toEqual(["Industrial Profits (YTD) YoY (CN)"]);
  const far = matchCalendarEvent("Dividend", null, calendar, now);
  expect(far).toEqual({ kind: "none", suggestions: [] });
});

test("a followed release is found when the feed renames it, from the same publisher", () => {
  const target = { kind: "release" as const, event: "NBS Manufacturing PMI", country: "CN", publisher: NBS.name };
  const renamed = [
    row("2026-11-30T01:30:00.000Z", "CN", "high", "Manufacturing PMI", { source: NBS, prior: "50.1" }),
    // Another publisher's PMI of the same words is not it.
    row("2026-11-30T01:45:00.000Z", "CN", "high", "Manufacturing PMI", { source: { name: "S&P Global" } }),
  ];
  expect(nextReleaseDate(renamed, target, "2026-11-01")).toBe("2026-11-30");
  expect(nextReleaseDate(renamed, { ...target, publisher: undefined }, "2026-11-01")).toBeNull();
  expect(releaseRowOn(target, "2026-11-30", renamed)?.source?.name).toBe(NBS.name);
});

test("the reminder counts to the release time, or in days to an all-day event; the print gives the figures", () => {
  const pmi = calendar.find((event) => event.event === "NBS Manufacturing PMI")!;
  const target = { kind: "release" as const, event: "NBS Manufacturing PMI", country: "CN" };
  expect(releaseReminderMessage(target, pmi, Date.parse("2026-10-30T04:30:00Z"))).toBe("NBS Manufacturing PMI (CN) in 21 hours, Sat, Oct 31, 01:30 UTC");
  const plenum = calendar.find((event) => event.event.includes("Plenum"))!;
  expect(releaseReminderMessage({ kind: "release", event: plenum.event, country: "CN" }, plenum, Date.parse("2026-10-25T09:00:00Z")))
    .toBe("Communist Party Fifth Plenum (CN) tomorrow, Mon, Oct 26, all day");
  expect(releasePrintMessage(target, { ...pmi, actual: "50.3", forecast: "50.0" })).toBe("NBS Manufacturing PMI (CN) 50.3 vs 50.0 expected, prior 50.1");
  // CPI and FOMC name the calendar row their figures come from.
  expect(releasePrintMessage({ kind: "macro", event: "cpi" }, row("2026-11-10T13:30:00.000Z", "US", "high", "Inflation Rate YoY", { actual: "3.1%", forecast: "3.0%", prior: "2.9%" })))
    .toBe("CPI release: Inflation Rate YoY 3.1% vs 3.0% expected, prior 2.9%");
});
