// Alerts on releases in the economic calendar (ECO, `gloom econ`): reading a
// release typed by name against the calendar's names, finding a followed
// release's rows as the calendar's feeds name it from week to week, and the
// notifications sent before it and once its figures are out. CPI and FOMC are
// two cases of the same alert, whose dates come from their own calendars.
import { dateKey, eventCountry, matchesCountry, type CountryFilter } from "../econ/calendar-model";
import { isAllDayEvent, hasNoReleaseTime, type EconEvent, type EconImpact } from "../econ/types";
import { MACRO_EVENT_NAMES } from "./research-builder";
import type { MacroAlertEvent } from "./research-rules";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** What a calendar alert follows: a release by the name and country the calendar lists it under. */
export interface CalendarReleaseTarget {
  kind: "release";
  event: string;
  country: string;
  /** Who publishes it, when the calendar names them. */
  publisher?: string;
}

/** CPI or FOMC, whose dates come from the BLS calendar and the Fed's meetings rather than the economic calendar. */
export interface MacroReleaseTarget {
  kind: "macro";
  event: MacroAlertEvent;
}

/**
 * The calendar rows that carry CPI's and FOMC's figures, by either feed's
 * name, headline first: the release a macro alert reports once it is out.
 */
const MACRO_RELEASE_NAMES: Record<MacroAlertEvent, readonly string[]> = {
  cpi: ["CPI y/y", "Inflation Rate YoY", "CPI m/m", "Inflation Rate MoM"],
  fomc: ["Federal Funds Rate", "Fed Interest Rate Decision"],
};

/**
 * A calendar name's words as they are matched: lower case, `y/y` as `yoy`
 * (the feeds write it both ways), S&P as `sp`, anything else not a letter or
 * a digit a space.
 */
export function calendarNameWords(name: string): string[] {
  return name.toLowerCase()
    .replace(/s&p/g, "sp")
    .replace(/\b([ymq])\/\1\b/g, "$1o$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

const nameKey = (name: string) => calendarNameWords(name).join(" ");

/** The UTC day the calendar lists a row under. */
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * Whether a row is still to come at `now`: a timed release before its time,
 * a row with a day and no time (an all-day event) through its day. One whose
 * time has passed is not, printed or not: an alert set after it would wait
 * for figures it never sends.
 */
function stillAhead(event: EconEvent, now: number): boolean {
  const at = releaseInstant(event);
  return at != null ? at > now : dateKey(event.date) >= utcDay(now);
}

/**
 * Whether a typed word names a word of a calendar name: the word itself, its
 * start (`manuf`), or the initials of a run of them (`NFP` for Non Farm
 * Payrolls).
 */
function wordFound(word: string, words: readonly string[]): boolean {
  if (words.some((candidate) => candidate === word || (word.length >= 3 && candidate.startsWith(word)))) return true;
  if (word.length < 2 || word.length > 5 || !/^[a-z]+$/.test(word)) return false;
  for (let start = 0; start + word.length <= words.length; start += 1) {
    if (words.slice(start, start + word.length).every((candidate, index) => candidate[0] === word[index])) return true;
  }
  return false;
}

/** One release the calendar lists: its name and country, with the next time it is listed for. */
export interface CalendarEventChoice {
  name: string;
  country: string;
  publisher: string | null;
  impact: EconImpact;
  /** Its next row still to come; null when the calendar lists none ahead (only past ones, or today's already out). */
  next: EconEvent | null;
}

const IMPACT_RANK: Record<EconImpact, number> = { high: 0, medium: 1, low: 2 };

type RankedChoice = CalendarEventChoice & { words: string[] };

/**
 * The calendar's releases, one per country and name, each with its next row
 * still to come at `now`, named as that row (or the latest one) names it.
 */
function calendarChoices(events: readonly EconEvent[], now: number): RankedChoice[] {
  const groups = new Map<string, EconEvent[]>();
  for (const event of [...events].sort((left, right) => left.date.getTime() - right.date.getTime())) {
    const words = calendarNameWords(event.event);
    if (words.length === 0) continue;
    const key = `${eventCountry(event)}|${words.join(" ")}`;
    groups.set(key, [...groups.get(key) ?? [], event]);
  }
  return [...groups.values()].map((rows) => {
    const next = rows.find((event) => stillAhead(event, now)) ?? null;
    const named = next ?? rows.at(-1)!;
    return {
      name: named.event,
      country: eventCountry(named),
      publisher: named.source?.name ?? rows.find((event) => event.source?.name)?.source?.name ?? null,
      impact: rows.reduce<EconImpact>((best, event) => IMPACT_RANK[event.impact] < IMPACT_RANK[best] ? event.impact : best, "low"),
      next,
      words: calendarNameWords(named.event),
    };
  });
}

/** What a typed release names in the calendar. */
export type CalendarEventMatch =
  /** One release, the best of those the words name, and the others they name in the same country. */
  | { kind: "match"; choice: CalendarEventChoice; others: CalendarEventChoice[] }
  /** The words name releases in several countries: the best of each. */
  | { kind: "countries"; choices: CalendarEventChoice[] }
  /** Nothing the words name; the nearest names, best first. */
  | { kind: "none"; suggestions: CalendarEventChoice[] };

/** Character pairs of a name, for how near a slip is to it. */
function pairs(text: string): Map<string, number> {
  const result = new Map<string, number>();
  const squeezed = text.replace(/ /g, "");
  for (let index = 0; index < squeezed.length - 1; index += 1) {
    const pair = squeezed.slice(index, index + 2);
    result.set(pair, (result.get(pair) ?? 0) + 1);
  }
  return result;
}

/** How alike two names are, 0 to 1, by the character pairs they share. */
function similarity(left: string, right: string): number {
  const a = pairs(left);
  const b = pairs(right);
  let shared = 0;
  let total = 0;
  for (const count of a.values()) total += count;
  for (const count of b.values()) total += count;
  for (const [pair, count] of a) shared += Math.min(count, b.get(pair) ?? 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

/** Words a release is typed as that its calendar name spells out. */
const QUERY_ALIASES: Record<string, readonly string[]> = { cpi: ["inflation", "rate"] };

/** Nearer than this to a typed name, a release is offered as what was meant. */
const SUGGESTION_SIMILARITY = 0.45;

/** Whether two words are one slip apart: a letter added, dropped, changed or two swapped. */
function oneSlipApart(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1 || Math.min(left.length, right.length) < 3) return false;
  let start = 0;
  while (start < left.length && left[start] === right[start]) start += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  const a = left.slice(start, leftEnd);
  const b = right.slice(start, rightEnd);
  return a.length <= 1 && b.length <= 1 || (a.length === 2 && b.length === 2 && a[0] === b[1] && a[1] === b[0]);
}

/**
 * The release `query` names among `events` in `country` (a country filter,
 * or any): the name itself, else every release whose name has each typed
 * word (`NBS PMI`, `CN PMI` with the country read off). Two or more words
 * also read as a word's start (`nbs manuf pmi`) or a name's initials; a
 * single word has to be one of the name's words (`PMI`, `Plenum`), so a
 * bare `MAN` or `NFP` is offered as what it may mean rather than added. Of
 * several in one country the highest impact wins, then one listed ahead,
 * then the closest name and the soonest date, so `NBS PMI` is the headline
 * NBS Manufacturing PMI and an old name listed only in the past never beats
 * the live one. Several countries ask which; no match offers the nearest
 * names.
 */
export function matchCalendarEvent(
  query: string,
  country: CountryFilter | null,
  events: readonly EconEvent[],
  now: number,
): CalendarEventMatch {
  const words = calendarNameWords(query);
  const choices = calendarChoices(country ? events.filter((event) => matchesCountry(event, country)) : events, now);
  const exact = choices.filter((choice) => choice.words.join(" ") === words.join(" "));
  const naming = (typed: readonly string[], loose: boolean) => typed.length === 0 ? [] : choices.filter((choice) =>
    typed.every((word) => loose ? wordFound(word, choice.words) : choice.words.includes(word)));
  // CPI by the name one feed gives it everywhere but the US (China's Inflation Rate YoY).
  const aliased = words.flatMap((word) => QUERY_ALIASES[word] ?? [word]);
  const typed = exact.length > 0 ? exact : naming(words, words.length > 1);
  const named = typed.length > 0 || aliased.join(" ") === words.join(" ") ? typed : naming(aliased, false);
  if (named.length === 0) {
    // Each typed word a slip from one of the name's (NBP PMI), or the name as a whole near what was typed.
    const slipped = choices.filter((choice) => words.length > 0
      && words.every((word) => wordFound(word, choice.words) || choice.words.some((candidate) => oneSlipApart(word, candidate))));
    const alike = choices
      .filter((choice) => !slipped.includes(choice))
      .map((choice) => ({ choice, score: similarity(words.join(" "), choice.words.join(" ")) }))
      .filter((entry) => entry.score >= SUGGESTION_SIMILARITY)
      .sort((left, right) => right.score - left.score || IMPACT_RANK[left.choice.impact] - IMPACT_RANK[right.choice.impact])
      .map((entry) => entry.choice);
    const ranked = slipped.sort((left, right) => IMPACT_RANK[left.impact] - IMPACT_RANK[right.impact] || left.words.length - right.words.length);
    return { kind: "none", suggestions: [...ranked, ...alike].slice(0, 3).map(strip) };
  }
  const ranked = named.sort((left, right) => IMPACT_RANK[left.impact] - IMPACT_RANK[right.impact]
    || (left.next ? 0 : 1) - (right.next ? 0 : 1)
    || (left.words.length - right.words.length)
    || (left.next?.date.getTime() ?? 0) - (right.next?.date.getTime() ?? 0)
    || left.name.localeCompare(right.name));
  const countries = [...new Set(ranked.map((choice) => choice.country))];
  if (countries.length > 1) {
    return { kind: "countries", choices: countries.map((code) => strip(ranked.find((choice) => choice.country === code)!)) };
  }
  return { kind: "match", choice: strip(ranked[0]!), others: ranked.slice(1).map(strip) };
}

function strip({ words: _words, ...choice }: RankedChoice): CalendarEventChoice {
  return choice;
}

/** "NBS Manufacturing PMI (CN)": a release as lists and notifications name it. */
export function calendarEventLabel(event: Pick<CalendarReleaseTarget, "event" | "country">): string {
  return `${event.event} (${event.country})`;
}

/** Words in front of a name that make it another series (NBS Non Manufacturing PMI beside NBS Manufacturing PMI), never a rename. */
const SERIES_QUALIFIERS = new Set(["non", "core", "ex", "final", "flash", "prel", "preliminary", "adv", "advance", "revised"]);

/**
 * How many words a feed put in front of a release's name, or took off it,
 * when `other` is that release under another title (`Manufacturing PMI` for
 * `NBS Manufacturing PMI`): the shorter name, two words at least, ends the
 * longer one, and the words in front are no qualifier. Null when `other` is
 * not the release.
 */
function renamedBy(words: readonly string[], other: readonly string[]): number | null {
  const [short, long] = words.length <= other.length ? [words, other] : [other, words];
  if (short.length < 2 || long.length === short.length) return null;
  const front = long.slice(0, long.length - short.length);
  if (long.slice(front.length).join(" ") !== short.join(" ") || front.some((word) => SERIES_QUALIFIERS.has(word))) return null;
  return front.length;
}

/**
 * A followed release's rows in the calendar. Its own name, on any day that
 * lists it; the feeds name a release differently from week to week
 * (`Manufacturing PMI` one week, `NBS Manufacturing PMI` the next), so on a
 * day without its own name, a row from the same publisher and country whose
 * name differs only by the words in front (`renamedBy`) is the release, the
 * closest of them where there are several. A sibling series that prints
 * beside it (NBS Non Manufacturing PMI) is never read as it.
 */
function releaseRows(target: CalendarReleaseTarget, events: readonly EconEvent[]): EconEvent[] {
  const words = calendarNameWords(target.event);
  const key = words.join(" ");
  const own = events.filter((event) => eventCountry(event) === target.country);
  const named = own.filter((event) => nameKey(event.event) === key);
  if (!target.publisher) return named;
  const namedDays = new Set(named.map((event) => dateKey(event.date)));
  const renamed = own.flatMap((event) => {
    if (namedDays.has(dateKey(event.date)) || event.source?.name !== target.publisher) return [];
    const front = renamedBy(words, calendarNameWords(event.event));
    return front == null ? [] : [{ event, front }];
  });
  const closest = new Map<string, number>();
  for (const { event, front } of renamed) {
    const day = dateKey(event.date);
    closest.set(day, Math.min(closest.get(day) ?? front, front));
  }
  return [...named, ...renamed.filter(({ event, front }) => closest.get(dateKey(event.date)) === front).map(({ event }) => event)];
}

/**
 * CPI or FOMC when a release named from the calendar is one of their rows in
 * the US (CPI y/y, Fed Interest Rate Decision): the macro alert follows it,
 * so the two never run side by side.
 */
export function macroEventNamed(release: Pick<CalendarEventChoice, "name" | "country">): MacroAlertEvent | null {
  if (release.country !== "US") return null;
  const key = nameKey(release.name);
  return (Object.keys(MACRO_RELEASE_NAMES) as MacroAlertEvent[]).find((event) => MACRO_RELEASE_NAMES[event].some((name) => nameKey(name) === key)) ?? null;
}

/** The rows of a macro release on its day, in the order its names are read. */
function macroRows(event: MacroAlertEvent, events: readonly EconEvent[]): EconEvent[] {
  const keys = MACRO_RELEASE_NAMES[event].map(nameKey);
  return events
    .filter((row) => eventCountry(row) === "US" && keys.includes(nameKey(row.event)))
    .sort((left, right) => keys.indexOf(nameKey(left.event)) - keys.indexOf(nameKey(right.event)));
}

/** The day (UTC) of a release's next row still to come at `now`; null when the calendar lists none ahead. */
export function nextReleaseDate(events: readonly EconEvent[], target: CalendarReleaseTarget, now: number): string | null {
  return releaseRows(target, events).filter((event) => stillAhead(event, now)).map((event) => dateKey(event.date)).sort()[0] ?? null;
}

/**
 * A release's row on `eventDate`: of the rows under its own name, else of
 * those that are it under another title, the one with its figures once they
 * are out, else the first listed. A macro release reads its headline row
 * (CPI y/y, the funds rate).
 */
export function releaseRowOn(
  target: CalendarReleaseTarget | MacroReleaseTarget,
  eventDate: string,
  events: readonly EconEvent[],
): EconEvent | null {
  const rows = (target.kind === "macro" ? macroRows(target.event, events) : releaseRows(target, events))
    .filter((event) => dateKey(event.date) === eventDate);
  const own = target.kind === "release" ? rows.filter((event) => nameKey(event.event) === nameKey(target.event)) : [];
  const pool = own.length > 0 ? own : rows;
  return pool.find((event) => event.actual) ?? pool[0] ?? null;
}

/** Whether a release prints figures (a PMI, a rate) rather than taking place (a plenum, a speech). */
export function expectsFigures(event: Pick<EconEvent, "actual" | "forecast" | "prior">): boolean {
  return !!(event.actual || event.forecast || event.prior);
}

/** The release time a row counts to; null for a row with a day and no time. */
export function releaseInstant(event: EconEvent): number | null {
  return hasNoReleaseTime(event) ? null : event.date.getTime();
}

const dayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/**
 * The reminder: "NBS Manufacturing PMI (CN) in 21 hours, Sat, Oct 31, 01:30
 * UTC", "Communist Party Fifth Plenum (CN) tomorrow, Mon, Oct 26, all day".
 * A timed release counts in hours its last two days, an all-day one in days.
 */
export function releaseReminderMessage(target: CalendarReleaseTarget, event: EconEvent, now: number): string {
  const day = dayFormat.format(event.date);
  const at = releaseInstant(event);
  if (at == null) {
    const days = Math.round((Date.parse(`${dateKey(event.date)}T00:00:00Z`) - Date.parse(`${utcDay(now)}T00:00:00Z`)) / DAY_MS);
    const when = days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    return `${calendarEventLabel(target)} ${when}, ${day}${isAllDayEvent(event) ? ", all day" : ""}`;
  }
  const left = at - now;
  const when = left < HOUR_MS
    ? `in ${Math.max(1, Math.round(left / 60_000))} minutes`
    : left < 2 * DAY_MS
      ? `in ${Math.round(left / HOUR_MS)} hours`
      : `in ${Math.floor(left / DAY_MS)} days`;
  return `${calendarEventLabel(target)} ${when}, ${day}, ${event.date.toISOString().slice(11, 16)} UTC`;
}

/**
 * The figures once out: "NBS Manufacturing PMI (CN) 50.3 vs 50.1 expected,
 * prior 50.1"; a macro alert names the row it read ("CPI release: CPI y/y
 * 3.1% vs 3.0% expected, prior 2.9%").
 */
export function releasePrintMessage(target: CalendarReleaseTarget | MacroReleaseTarget, event: EconEvent): string {
  const label = target.kind === "macro" ? `${MACRO_EVENT_NAMES[target.event]}: ${event.event}` : calendarEventLabel(target);
  return `${label} ${event.actual}${event.forecast ? ` vs ${event.forecast} expected` : ""}${event.prior ? `, prior ${event.prior}` : ""}`;
}

/** A printed figure as a number and its unit (`3.1%` is 3.1 in %), for the log of fired alerts; null for any other text. */
export function printedValue(actual: string | null): { value: number; unit?: string } | null {
  const match = /^([+-]?\d+(?:\.\d+)?)(%?)$/.exec(actual?.trim() ?? "");
  if (!match) return null;
  return { value: Number(match[1]), ...(match[2] ? { unit: "%" } : {}) };
}
