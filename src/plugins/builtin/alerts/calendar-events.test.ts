import { expect, test } from "bun:test";
import type { EconEvent, EconImpact } from "../econ/types";
import {
  macroEventNamed,
  matchCalendarEvent,
  nextReleaseDate,
  releasePrintMessage,
  releaseReminderMessage,
  releaseRenameNote,
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
  // With two words or more a word's start and a name's initials read too, any case.
  for (const query of ["nbs manuf pmi", "Industrial Profits", "NFP payrolls"]) {
    expect(matchCalendarEvent(query, null, calendar, now).kind).toBe("match");
  }
  // A single word has to be one of the name's words: a bare start or initials is offered, not taken.
  const nfp = matchCalendarEvent("NFP", null, calendar, now);
  expect(nfp.kind === "none" && names(nfp.suggestions)).toEqual(["Non Farm Payrolls (US)"]);
  const man = matchCalendarEvent("MAN", "CN", calendar, now);
  expect(man.kind === "none" && names(man.suggestions)).toEqual(["NBS Manufacturing PMI (CN)", "RatingDog Manufacturing PMI (CN)", "NBS Non Manufacturing PMI (CN)"]);
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

test("a followed release is found when the feed renames it, and never in a sibling series printing beside it", () => {
  const target = { kind: "release" as const, event: "NBS Manufacturing PMI", country: "CN", publisher: NBS.name };
  const rows = [
    // Its own day: the non-manufacturing PMI prints first; the manufacturing one is still to come.
    row("2026-10-31T01:30:00.000Z", "CN", "medium", "NBS Non Manufacturing PMI", { source: NBS, actual: "50.6", prior: "50.2" }),
    row("2026-10-31T01:30:00.000Z", "CN", "high", "NBS Manufacturing PMI", { source: NBS, prior: "50.1" }),
    // A month on, the feed drops the NBS in front of both.
    row("2026-11-30T01:30:00.000Z", "CN", "medium", "Non Manufacturing PMI", { source: NBS, actual: "50.9" }),
    row("2026-11-30T01:30:00.000Z", "CN", "high", "Manufacturing PMI", { source: NBS, prior: "50.1" }),
    // Another publisher's PMI of the same words is not it.
    row("2026-12-01T01:45:00.000Z", "CN", "high", "Manufacturing PMI", { source: { name: "S&P Global" } }),
    // Nor is the sibling alone on a day without the release.
    row("2026-12-31T01:30:00.000Z", "CN", "medium", "NBS Non Manufacturing PMI", { source: NBS, actual: "50.1" }),
  ];
  expect(releaseRowOn(target, "2026-10-31", rows)).toMatchObject({ event: "NBS Manufacturing PMI", actual: null });
  expect(releaseRowOn(target, "2026-11-30", rows)).toMatchObject({ event: "Manufacturing PMI", actual: null });
  expect(releaseRowOn(target, "2026-12-01", rows)).toBeNull();
  expect(releaseRowOn(target, "2026-12-31", rows)).toBeNull();
  expect(nextReleaseDate(rows, target, Date.parse("2026-11-01T00:00:00Z"))).toBe("2026-11-30");
  expect(nextReleaseDate(rows, { ...target, publisher: undefined }, Date.parse("2026-11-01T00:00:00Z"))).toBeNull();
  // Followed under its old name, the release is the renamed row, not the sibling.
  const old = { ...target, event: "Manufacturing PMI" };
  expect(releaseRowOn(old, "2026-10-31", rows)).toMatchObject({ event: "NBS Manufacturing PMI" });
  expect(releaseRowOn(old, "2026-12-31", rows)).toBeNull();
});

test("a series' former name reads as its current one, saying so, and an alert kept under it follows the renamed rows", () => {
  const caixin = matchCalendarEvent("Caixin PMI", null, calendar, now);
  expect(caixin.kind === "match" && [caixin.choice.name, caixin.choice.next?.date.toISOString()])
    .toEqual(["RatingDog Manufacturing PMI", "2026-11-02T01:45:00.000Z"]);
  expect(caixin.renamed).toEqual({ former: "Caixin", current: "RatingDog", since: "the August 2025 survey" });
  expect(releaseRenameNote(caixin.renamed!)).toBe("Caixin releases were renamed RatingDog from the August 2025 survey.");
  // A former name the calendar has nothing for still says it was renamed, beside the nearest names.
  const construction = matchCalendarEvent("Caixin Construction PMI", "CN", calendar, now);
  expect(construction.kind).toBe("none");
  expect(construction.renamed?.current).toBe("RatingDog");
  // A name with no former one is matched as typed.
  expect(matchCalendarEvent("RatingDog PMI", null, calendar, now).renamed).toBeUndefined();

  const followed = { kind: "release" as const, event: "Caixin Manufacturing PMI", country: "CN" };
  expect(releaseRowOn(followed, "2026-11-02", calendar)).toMatchObject({ event: "RatingDog Manufacturing PMI" });
  expect(nextReleaseDate(calendar, followed, now)).toBe("2026-11-02");
});

test("a release listed ahead beats an old name listed only in the past, and one already out today is not its next", () => {
  const past = row("2026-09-30T01:30:00.000Z", "CN", "high", "Manufacturing PMI", { actual: "49.8", source: NBS });
  const pmi = matchCalendarEvent("PMI", "CN", [past, ...calendar], now);
  expect(pmi.kind === "match" && [pmi.choice.name, pmi.choice.next?.date.toISOString()]).toEqual(["NBS Manufacturing PMI", "2026-10-31T01:30:00.000Z"]);
  // Just after it printed, its next is the one listed after, or none.
  const printed = calendar.map((event) => event.event === "NBS Manufacturing PMI" ? { ...event, actual: "50.3" } : event);
  const later = [...printed, row("2026-11-30T01:30:00.000Z", "CN", "high", "NBS Manufacturing PMI", { prior: "50.3", source: NBS })];
  const afterPrint = Date.parse("2026-10-31T03:00:00Z");
  const next = matchCalendarEvent("NBS Manufacturing PMI", null, later, afterPrint);
  expect(next.kind === "match" && next.choice.next?.date.toISOString()).toBe("2026-11-30T01:30:00.000Z");
  const none = matchCalendarEvent("NBS Manufacturing PMI", null, printed, afterPrint);
  expect(none.kind === "match" && none.choice.next).toBeNull();
});

test("CPI's and the FOMC's own calendar rows in the US are the CPI and FOMC alerts", () => {
  expect([
    macroEventNamed({ name: "CPI y/y", country: "US" }),
    macroEventNamed({ name: "Inflation Rate YoY", country: "US" }),
    macroEventNamed({ name: "Fed Interest Rate Decision", country: "US" }),
    macroEventNamed({ name: "Core Inflation Rate YoY", country: "US" }),
    macroEventNamed({ name: "Inflation Rate YoY", country: "CN" }),
  ]).toEqual(["cpi", "cpi", "fomc", null, null]);
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
